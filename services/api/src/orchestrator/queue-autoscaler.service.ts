import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Docker from 'dockerode';

/**
 * Queue Autoscaler — HPA-like pour Docker Swarm.
 *
 * Pattern : poll RabbitMQ Management API toutes les 30s, compare la depth
 * de chaque queue à des seuils, et scale up/down le service Swarm worker
 * correspondant via Docker socket.
 *
 * Pourquoi : Docker Swarm n'a pas d'auto-scaling natif (vs Kubernetes
 * HPA). Si un worker (ais-decoder) prend du retard sur sa queue, le
 * backlog s'accumule (vu 405k messages sur ais.decoder en cas réel).
 * Solution : un cron qui ajuste replicas en fonction de la demande.
 *
 * Pré-requis :
 *   - Socket Docker monté : /var/run/docker.sock dans le container api
 *   - Service api doit tourner sur un node manager (single-node NAS OK)
 *   - RabbitMQ Management API joignable (port 15672 interne)
 *
 * Tuning :
 *   - scaleUpThreshold = depth qui déclenche +1 replica
 *   - scaleDownThreshold = depth en dessous duquel on candidate scale down
 *   - SCALE_DOWN_DEBOUNCE_MS = temps en low avant scale down (anti-flap)
 *   - min/maxReplicas = bornes
 */
interface AutoscaleTarget {
  /** RabbitMQ queue name */
  queue: string;
  /** Swarm service name (`<stack>_<service>`) */
  service: string;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  minReplicas: number;
  maxReplicas: number;
}

@Injectable()
export class QueueAutoscalerService implements OnModuleInit {
  private readonly logger = new Logger(QueueAutoscalerService.name);
  private readonly docker = new Docker({ socketPath: '/var/run/docker.sock' });
  private readonly rabbitmqApi = process.env.RABBITMQ_API_URL || 'http://rabbitmq:15672/api';
  private auth = '';

  /** Anti-flap : timestamp du début de la période "low" par service. */
  private readonly lowSince = new Map<string, number>();
  private readonly SCALE_DOWN_DEBOUNCE_MS = 5 * 60 * 1000; // 5 min low → scale down

  /**
   * Targets — extensible. Pour ajouter un autoscale sur une autre queue
   * (ex alerts-engine), ajouter une entry ici. Pour disabler le pattern,
   * vider le tableau (le cron tournera mais ne fera rien).
   */
  private readonly targets: AutoscaleTarget[] = [
    {
      queue: 'ais.decoder',
      service: 'maritime_ais-decoder',
      scaleUpThreshold: 1000,
      scaleDownThreshold: 100,
      minReplicas: 1,
      maxReplicas: 5,
    },
  ];

  onModuleInit() {
    const user = process.env.RABBITMQ_USER || 'maritime';
    const pass = process.env.RABBITMQ_PASSWORD || 'maritime';
    this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    this.logger.log(`Autoscaler initialized — ${this.targets.length} targets`);
  }

  /** Cron toutes les 30s. Évalue chaque target indépendamment. */
  @Cron('*/30 * * * * *')
  async check() {
    for (const target of this.targets) {
      try {
        await this.evaluateTarget(target);
      } catch (e) {
        this.logger.error(`Autoscale eval failed for ${target.service}: ${(e as Error).message}`);
      }
    }
  }

  private async evaluateTarget(t: AutoscaleTarget): Promise<void> {
    const depth = await this.getQueueDepth(t.queue);
    const service = this.docker.getService(t.service);
    const info: any = await service.inspect();
    const current: number = info.Spec?.Mode?.Replicated?.Replicas ?? 1;

    if (depth > t.scaleUpThreshold && current < t.maxReplicas) {
      const targetReplicas = current + 1;
      this.logger.log(
        `SCALE UP ${t.service}: ${current} → ${targetReplicas} (queue ${t.queue} depth=${depth} > ${t.scaleUpThreshold})`,
      );
      await this.applyScale(service, info, targetReplicas);
      this.lowSince.delete(t.service);
    } else if (depth < t.scaleDownThreshold && current > t.minReplicas) {
      const sinceLow = this.lowSince.get(t.service) ?? Date.now();
      if (!this.lowSince.has(t.service)) {
        this.lowSince.set(t.service, sinceLow);
        this.logger.debug(`${t.service} entered low state (depth=${depth})`);
      }
      const lowMs = Date.now() - sinceLow;
      if (lowMs >= this.SCALE_DOWN_DEBOUNCE_MS) {
        const targetReplicas = current - 1;
        this.logger.log(
          `SCALE DOWN ${t.service}: ${current} → ${targetReplicas} (queue ${t.queue} depth=${depth} < ${t.scaleDownThreshold} for ${Math.round(lowMs / 1000)}s)`,
        );
        await this.applyScale(service, info, targetReplicas);
        this.lowSince.delete(t.service);
      }
    } else {
      // Stable or above-low : reset debounce
      this.lowSince.delete(t.service);
    }
  }

  /**
   * Récupère depth (= messages totaux : ready + unacked) via RabbitMQ
   * Management API. Default vhost "/" = "%2F" URL-encoded.
   */
  private async getQueueDepth(queue: string): Promise<number> {
    const encoded = encodeURIComponent(queue);
    const url = `${this.rabbitmqApi}/queues/%2F/${encoded}`;
    const res = await fetch(url, { headers: { Authorization: this.auth } });
    if (!res.ok) {
      throw new Error(`RabbitMQ Management API ${res.status} ${res.statusText}`);
    }
    const data: any = await res.json();
    return data.messages ?? 0;
  }

  /**
   * Apply scale via Docker socket. Note : Docker Swarm exige le version
   * index actuel + le spec complet (PATCH-like API). Dockerode wrap ça.
   */
  private async applyScale(service: Docker.Service, info: any, replicas: number): Promise<void> {
    const spec = info.Spec;
    if (!spec.Mode?.Replicated) {
      throw new Error('Service is not in replicated mode (cannot autoscale)');
    }
    spec.Mode.Replicated.Replicas = replicas;
    await service.update({
      version: info.Version.Index,
      ...spec,
    });
  }
}

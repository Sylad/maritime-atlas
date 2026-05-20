import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

/**
 * Wrapper Resend pour les mails transactionnels (verification + reset).
 *
 * Mode dégradé : si `RESEND_API_KEY` vide, on log juste le mail
 * (utile en dev local sans domain DKIM/SPF configuré). Cela permet de
 * tester register/verify sans dépendance externe.
 *
 * Free tier Resend : 3000 mails/mois, 100/jour. Largement suffisant.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly fromEmail: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('resendApiKey') || '';
    this.fromEmail = this.config.get<string>('resendFromEmail') || 'noreply@sladoire.dev';
    this.publicBaseUrl = (this.config.get<string>('publicBaseUrl') || '').replace(/\/$/, '');
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY non set — mails de vérification seront logués mais pas envoyés');
      this.resend = null;
    } else {
      this.resend = new Resend(apiKey);
    }
  }

  /**
   * Envoie le mail de vérification post-register.
   *
   * Mail volontairement minimaliste — pas de HTML lourd, juste un lien
   * cliquable. Le user reçoit ça en ~30s après son register.
   */
  async sendVerificationEmail(toEmail: string, username: string, token: string): Promise<void> {
    const verifyUrl = `${this.publicBaseUrl}/auth/verify?token=${encodeURIComponent(token)}`;
    const subject = 'AetherWX — vérifie ton email';

    const text = [
      `Bonjour ${username},`,
      ``,
      `Merci pour ton inscription sur AetherWX !`,
      ``,
      `Pour finaliser la création de ton compte, clique sur le lien ci-dessous`,
      `(valide 24h) :`,
      ``,
      `  ${verifyUrl}`,
      ``,
      `Si tu n'es pas à l'origine de cette inscription, ignore ce mail.`,
      ``,
      `— L'équipe AetherWX`,
    ].join('\n');

    const html = `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0a0e1a; color:#e6ecf3; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: rgb(15, 23, 42); border: 1px solid hsl(224, 85%, 55%); border-radius: 12px; padding: 32px;">
    <h1 style="margin-top:0; color: hsl(226, 92%, 72%); font-size: 20px;">AetherWX</h1>
    <p>Bonjour <strong>${this.escapeHtml(username)}</strong>,</p>
    <p>Merci pour ton inscription. Clique sur le bouton ci-dessous pour vérifier ton email (valide 24h) :</p>
    <p style="margin: 24px 0;">
      <a href="${verifyUrl}" style="display: inline-block; padding: 10px 20px; background: hsl(224, 80%, 58%); color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Vérifier mon email</a>
    </p>
    <p style="font-size: 12px; color: #8a96a8;">Ou copie ce lien dans ton navigateur :<br><a href="${verifyUrl}" style="color: hsl(226, 92%, 72%); word-break: break-all;">${verifyUrl}</a></p>
    <p style="font-size: 12px; color: #5a6478; margin-top: 32px;">Si tu n'es pas à l'origine de cette inscription, ignore ce mail.</p>
  </div>
</body></html>
    `.trim();

    if (!this.resend) {
      this.logger.log(`[DEV] Mail verification — to=${toEmail} url=${verifyUrl}`);
      return;
    }

    try {
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: toEmail,
        subject,
        text,
        html,
      });
      if (result.error) {
        this.logger.error(`Resend send failed: ${JSON.stringify(result.error)}`);
        throw new Error(`Resend error: ${result.error.message || 'unknown'}`);
      }
      this.logger.log(`Mail verification envoyé à ${toEmail} (id=${result.data?.id})`);
    } catch (err) {
      this.logger.error(`Resend send threw: ${err instanceof Error ? err.message : String(err)}`);
      // ne rejette pas — le user a quand même son compte créé, il pourra
      // resend via /auth/resend-verification (à implémenter en Phase 2.B)
    }
  }

  /**
   * Mail reset password — Phase B Auth refonte. Lien valide 1h vers
   * `${publicBaseUrl}/auth/reset-password?token=...`.
   */
  async sendPasswordResetEmail(toEmail: string, username: string, token: string): Promise<void> {
    const resetUrl = `${this.publicBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
    const subject = 'AetherWX — réinitialise ton mot de passe';

    const text = [
      `Bonjour ${username},`,
      ``,
      `Tu as demandé une réinitialisation de mot de passe sur AetherWX.`,
      ``,
      `Clique sur le lien ci-dessous (valide 1h) :`,
      ``,
      `  ${resetUrl}`,
      ``,
      `Si tu n'es pas à l'origine de cette demande, ignore ce mail —`,
      `ton mot de passe actuel reste inchangé.`,
      ``,
      `— L'équipe AetherWX`,
    ].join('\n');

    const html = `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0a0e1a; color:#e6ecf3; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: rgb(15, 23, 42); border: 1px solid hsl(224, 85%, 55%); border-radius: 12px; padding: 32px;">
    <h1 style="margin-top:0; color: hsl(226, 92%, 72%); font-size: 20px;">AetherWX</h1>
    <p>Bonjour <strong>${this.escapeHtml(username)}</strong>,</p>
    <p>Tu as demandé une réinitialisation de mot de passe. Clique sur le bouton ci-dessous (valide 1h) :</p>
    <p style="margin: 24px 0;">
      <a href="${resetUrl}" style="display: inline-block; padding: 10px 20px; background: hsl(224, 80%, 58%); color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Réinitialiser mon mot de passe</a>
    </p>
    <p style="font-size: 12px; color: #8a96a8;">Ou copie ce lien dans ton navigateur :<br><a href="${resetUrl}" style="color: hsl(226, 92%, 72%); word-break: break-all;">${resetUrl}</a></p>
    <p style="font-size: 12px; color: #5a6478; margin-top: 32px;">Si tu n'es pas à l'origine de cette demande, ignore ce mail — ton mot de passe actuel reste inchangé.</p>
  </div>
</body></html>
    `.trim();

    if (!this.resend) {
      this.logger.log(`[DEV] Mail reset password — to=${toEmail} url=${resetUrl}`);
      return;
    }

    try {
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: toEmail,
        subject,
        text,
        html,
      });
      if (result.error) {
        this.logger.error(`Resend reset send failed: ${JSON.stringify(result.error)}`);
        throw new Error(`Resend error: ${result.error.message || 'unknown'}`);
      }
      this.logger.log(`Mail reset password envoyé à ${toEmail} (id=${result.data?.id})`);
    } catch (err) {
      this.logger.error(`Resend reset threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

package fr.sladoire.maritime.idw;

import org.geotools.process.factory.AnnotatedBeanProcessFactory;
import org.geotools.text.Text;

/**
 * @deprecated DEPRECATED depuis 2026-05-15 — migration vers le pattern
 *     {@link IDWFunction} / {@link IDWContourFunction} qui implémentent
 *     {@code CoverageReadingTransformation} (cf docs sur ces classes).
 *
 * <p>Cette classe est CONSERVÉE uniquement pour que le catalogue GS JDBCConfig
 * persisté (xstream sérialise les noms FQN dans le workspace) puisse charger
 * sans crash au boot après suppression de l'enregistrement SPI ProcessFactory.
 *
 * <p>Elle n'enregistre AUCUN process (constructeur vide → 0 classes annotées).
 * Ainsi GS résout la classe sans erreur, et l'instance ne pollue pas les
 * WPS GetCapabilities.
 *
 * <p>À supprimer définitivement quand le catalogue persisté aura été nettoyé
 * de toute référence à ce nom (faire un cycle PUT WPS settings vide via REST,
 * ou un dump xml→clean→restore du jdbcconfig).
 */
@Deprecated
public class IDWProcessFactory extends AnnotatedBeanProcessFactory {

    public IDWProcessFactory() {
        // 0 classes : ne registre aucun process. Reste lookable par xstream
        // pour permettre la deserialization du catalogue GS legacy.
        super(Text.text("Maritime IDW processes (legacy stub)"), "idw");
    }
}

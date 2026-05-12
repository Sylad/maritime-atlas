package fr.sladoire.maritime.idw;

import org.geotools.process.factory.AnnotatedBeanProcessFactory;
import org.geotools.text.Text;

/**
 * GeoTools ProcessFactory pour le namespace `idw:`. Découvre toutes les
 * classes annotées @DescribeProcess dans le package et les expose comme
 * WPS processes utilisables dans les SLDs <Transformation>.
 *
 * Enregistrement via SPI :
 *   META-INF/services/org.geotools.process.ProcessFactory
 * doit contenir une ligne : fr.sladoire.maritime.idw.IDWProcessFactory
 *
 * Pattern copié de org.geotools.process.raster.RasterProcessFactory
 * (cf https://github.com/geotools/geotools/blob/main/modules/unsupported/
 * process-raster/src/main/java/org/geotools/process/raster/RasterProcessFactory.java).
 */
public class IDWProcessFactory extends AnnotatedBeanProcessFactory {

    public IDWProcessFactory() {
        super(Text.text("Maritime IDW processes"), "idw", IDWProcess.class);
    }
}

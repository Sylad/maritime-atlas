# Build-only Dockerfile pour le plugin GeoServer IDW.
# Usage :
#   docker build -t maritime-gs-idw-build .
#   docker run --rm -v $(pwd):/build maritime-gs-idw-build cp /jar/gs-idw-process-0.1.0.jar /build/target/
#
# Alternative pure-Maven sans Docker :
#   docker run --rm -v $(pwd):/build -v $HOME/.m2:/root/.m2 -w /build \
#     maven:3.9-eclipse-temurin-17 mvn package -DskipTests
#
# Le JAR résultant (target/gs-idw-process-0.1.0.jar) doit être copié
# dans le container GeoServer :
#   /usr/local/tomcat/webapps/geoserver/WEB-INF/lib/
# puis restart GeoServer pour que le SPI ProcessFactory soit chargé.
FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /build
COPY pom.xml .
COPY src ./src
RUN mvn package -DskipTests

FROM busybox
COPY --from=builder /build/target/*.jar /jar/

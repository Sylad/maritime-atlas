<?xml version="1.0" encoding="UTF-8"?>
<!--
    Tomcat context.xml template — sprint refacto archi GeoServer 2026-05-16.

    Source of truth UNIQUE pour les credentials Postgres GS.
    Au boot, cluster-bootstrap.sh fait envsubst < context.xml.tpl > context.xml
    pour injecter les valeurs depuis les env vars du pod.

    Datasource JNDI exposée : java:comp/env/jdbc/geoserver
    Consommée par :
      - JDBCConfig (catalog : workspaces, layers, stores, styles)
      - JDBCStore (resources : SLD bodies, icons, etc.)
      - JDBC Sessions (PersistentManager Tomcat ci-dessous)
      - ImageMosaic JDBC (granule index via datastore.properties qui
        référence le JNDI au lieu d'embarquer les credentials)

    Voir cahier des charges Sylvain dans la mémoire
    maritime_geoserver_target_architecture.md.
-->
<Context>

    <!-- ════════════════════════════════════════════════════════════════
         JNDI datasource — pool de connexions Postgres partagé.
         Toutes les connexions GS passent par lui.
         ════════════════════════════════════════════════════════════════ -->
    <Resource
        name="jdbc/geoserver"
        auth="Container"
        type="javax.sql.DataSource"
        driverClassName="org.postgresql.Driver"

        url="jdbc:postgresql://${POSTGRES_HOST}:${POSTGRES_PORT}/${GEOSERVER_DB_NAME}"
        username="${GEOSERVER_DB_USER}"
        password="${GEOSERVER_DB_PASSWORD}"

        maxTotal="20"
        maxIdle="5"
        maxWaitMillis="10000"
        minIdle="2"
        timeBetweenEvictionRunsMillis="30000"

        validationQuery="SELECT 1"
        testOnBorrow="true"
        testWhileIdle="true"

        removeAbandonedOnBorrow="true"
        removeAbandonedTimeout="60"
        logAbandoned="true"
    />

    <!-- ════════════════════════════════════════════════════════════════
         JDBC Sessions — partage les sessions Tomcat entre les replicas GS.
         Sans ça, le round-robin K8s Service entre les pods invalide la
         session UI à chaque requête (login GS Web Admin pète).

         PersistentManager + DataSourceStore via le même datasource JNDI.
         Tomcat crée la table `tomcat_sessions` si pas existante (CREATE
         TABLE IF NOT EXISTS via le DataSourceStore au premier boot).
         ════════════════════════════════════════════════════════════════ -->
    <Manager
        className="org.apache.catalina.session.PersistentManager"
        maxIdleBackup="60"
        processExpiresFrequency="6"
        sessionAttributeNameFilter="^(?!org\.apache\.).*$"
    >
        <Store
            className="org.apache.catalina.session.JDBCStore"
            dataSourceName="jdbc/geoserver"
            localDataSource="true"

            sessionTable="tomcat_sessions"
            sessionIdCol="session_id"
            sessionValidCol="valid_session"
            sessionMaxInactiveCol="max_inactive"
            sessionLastAccessedCol="last_access"
            sessionAppCol="app_name"
            sessionDataCol="session_data"
        />
    </Manager>

</Context>

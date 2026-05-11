#!/bin/bash
# Provisionne le BlobStore S3 pour GWC dans le cluster GeoServer.
# Pointe vers SeaweedFS (docker DNS alias `seaweedfs:8333`), bucket
# `maritime-gwc-tiles` (créé via aws cli au step 1).
#
# Idempotent : PUT remplace le BlobStore s'il existe déjà.
# Utilisation :
#   docker exec maritime-geoserver-1 bash /cluster-config/gwc-blobstore-s3.sh
# OU depuis l'hôte :
#   ./gwc-blobstore-s3.sh
set -e

GS_URL="${GS_URL:-http://localhost:8080/geoserver}"
GS_USER="${GS_USER:-admin}"
GS_PASS="${GS_PASS:-geoserver}"

S3_BUCKET="${S3_BUCKET:-maritime-gwc-tiles}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-maritime}"
S3_SECRET_KEY="${S3_SECRET_KEY:-maritime-s3-homelab-2026}"

# Le endpoint AWS S3 est passé en JVM property côté EXTRA_JAVA_OPTS
# (-Daws.s3.endpoint=http://seaweedfs:8333). Le BlobStore XML n'a pas
# de field `endpoint` natif — il est pris au runtime par l'AWS SDK.

S3_ENDPOINT="${S3_ENDPOINT:-http://seaweedfs:8333}"

cat > /tmp/blobstore-s3.xml <<XML
<S3BlobStore default="false">
  <id>maritime-s3</id>
  <enabled>true</enabled>
  <bucket>${S3_BUCKET}</bucket>
  <prefix>gwc</prefix>
  <awsAccessKey>${S3_ACCESS_KEY}</awsAccessKey>
  <awsSecretKey>${S3_SECRET_KEY}</awsSecretKey>
  <endpoint>${S3_ENDPOINT}</endpoint>
  <access>PRIVATE</access>
  <maxConnections>50</maxConnections>
  <useHttps>false</useHttps>
  <useGzip>true</useGzip>
</S3BlobStore>
XML

echo "[gwc-blobstore-s3] PUT /gwc/rest/blobstores/maritime-s3"
HTTP_CODE=$(curl -s -o /tmp/blobstore-put.log -w "%{http_code}" \
  -u "${GS_USER}:${GS_PASS}" \
  -X PUT \
  -H "Content-Type: application/xml" \
  -d @/tmp/blobstore-s3.xml \
  "${GS_URL}/gwc/rest/blobstores/maritime-s3")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "[gwc-blobstore-s3] OK ($HTTP_CODE) — BlobStore 'maritime-s3' configuré"
else
  echo "[gwc-blobstore-s3] FAIL ($HTTP_CODE)"
  cat /tmp/blobstore-put.log
  exit 1
fi

# Verify the BlobStore is listed
echo ""
echo "[gwc-blobstore-s3] List active blobstores :"
curl -sf -u "${GS_USER}:${GS_PASS}" "${GS_URL}/gwc/rest/blobstores.xml" 2>&1 | head -20

echo ""
echo "[gwc-blobstore-s3] done. Prochaine étape : assigner ce BlobStore"
echo "à un layer via Tile Caching UI ou un autre PUT vers"
echo "/gwc/rest/layers/<layerName>.xml en y déclarant <blobStoreId>maritime-s3</blobStoreId>"

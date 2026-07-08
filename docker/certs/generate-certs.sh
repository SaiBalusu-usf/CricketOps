#!/bin/sh
set -eu

LAN_IP="${LAN_IP:-127.0.0.1}"
DNS_NAMES="${DNS_NAMES:-localhost,cricketops.local}"
META="/certs/cert.meta"
NEXT_META="LAN_IP=${LAN_IP};DNS_NAMES=${DNS_NAMES}"

if [ -f /certs/ca.crt ] && [ -f /certs/server.crt ] && [ -f /certs/server.key ] \
  && [ -f "$META" ] && [ "$(cat "$META")" = "$NEXT_META" ]; then
  echo "certificates already match ${NEXT_META}"
  exit 0
fi

rm -f /certs/ca.crt /certs/ca.key /certs/server.crt /certs/server.key /tmp/server.cnf

openssl genrsa -out /certs/ca.key 4096
openssl req -x509 -new -nodes -key /certs/ca.key -sha256 -days 3650 \
  -subj "/CN=CricketOps Local CA" \
  -out /certs/ca.crt

cat >/tmp/server.cnf <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
CN = CricketOps Local

[req_ext]
subjectAltName = @alt_names

[alt_names]
IP.1 = ${LAN_IP}
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

i=2
OLD_IFS="$IFS"
IFS=","
for name in $DNS_NAMES; do
  clean="$(echo "$name" | xargs)"
  if [ -n "$clean" ] && [ "$clean" != "localhost" ]; then
    echo "DNS.${i} = ${clean}" >> /tmp/server.cnf
    i=$((i + 1))
  fi
done
IFS="$OLD_IFS"

openssl genrsa -out /certs/server.key 2048
openssl req -new -key /certs/server.key -out /tmp/server.csr -config /tmp/server.cnf
openssl x509 -req -in /tmp/server.csr -CA /certs/ca.crt -CAkey /certs/ca.key \
  -CAcreateserial -out /certs/server.crt -days 825 -sha256 \
  -extensions req_ext -extfile /tmp/server.cnf

chmod 600 /certs/ca.key /certs/server.key
printf "%s" "$NEXT_META" > "$META"
echo "generated local CA and server certificate for ${LAN_IP}"

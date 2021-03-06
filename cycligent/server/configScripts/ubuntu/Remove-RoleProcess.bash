#!/usr/bin/env bash

SCRIPT_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )

. $SCRIPT_DIR/shared.bash

SERVER_IP_ADDRESS=$1
USERNAME=$2
FRIENDLY_NAME=$3
PRIVATE_KEY=$4
TEMP_PRIVATE_KEY_FILE=$(make_temp_private_key_file "$PRIVATE_KEY")

scp -o StrictHostKeyChecking=no -o LogLevel=error -i "$TEMP_PRIVATE_KEY_FILE" /usr/local/bin/cy "$USERNAME@$SERVER_IP_ADDRESS":/usr/local/bin/cy

ssh -o StrictHostKeyChecking=no -o LogLevel=error -i "$TEMP_PRIVATE_KEY_FILE" "$USERNAME@$SERVER_IP_ADDRESS" <<ENDTEXT
cy remove "$FRIENDLY_NAME"
ENDTEXT

rm "$TEMP_PRIVATE_KEY_FILE"
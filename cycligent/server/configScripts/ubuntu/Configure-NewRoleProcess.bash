#!/usr/bin/env bash

SCRIPT_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )

. $SCRIPT_DIR/shared.bash

NEW_SERVER_IP_ADDRESS=$1
USERNAME=$2
DEPLOYMENT_NAME=$3
FRIENDLY_NAME=$4
ROLE_PROCESS_ID=$5
SET_ID=$6
VERSION_TYPE=$7
ROLE_TYPE=$8
IS_CYVISOR=$9
PRIVATE_KEY=${10}
TEMP_PRIVATE_KEY_FILE=$(make_temp_private_key_file "$PRIVATE_KEY")

scp -o StrictHostKeyChecking=no -o LogLevel=error -i "$TEMP_PRIVATE_KEY_FILE" /usr/local/bin/cy "$USERNAME@$NEW_SERVER_IP_ADDRESS":/usr/local/bin/cy

ssh -o StrictHostKeyChecking=no -o LogLevel=error -i "$TEMP_PRIVATE_KEY_FILE" "$USERNAME@$NEW_SERVER_IP_ADDRESS" <<ENDTEXT
cy add "$DEPLOYMENT_NAME" "$FRIENDLY_NAME" "$ROLE_PROCESS_ID" "$SET_ID" "$VERSION_TYPE" "$ROLE_TYPE" "$IS_CYVISOR" "80"
ENDTEXT

rm "$TEMP_PRIVATE_KEY_FILE"
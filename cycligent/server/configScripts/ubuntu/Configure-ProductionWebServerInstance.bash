#!/usr/bin/env bash

SCRIPT_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )

. $SCRIPT_DIR/shared.bash

NEW_SERVER_IP_ADDRESS=$1
USERNAME=$2
CYVISOR_PUBLIC_DNS=$3
CYVISOR_SAMBA_PASSWORD=$4
PRIVATE_KEY=$5
TEMP_PRIVATE_KEY_FILE=$(make_temp_private_key_file "$PRIVATE_KEY")

scp -o StrictHostKeyChecking=no -o LogLevel=error -i "$TEMP_PRIVATE_KEY_FILE" /usr/local/bin/cy "$USERNAME@$NEW_SERVER_IP_ADDRESS":/usr/local/bin/cy

ssh -o StrictHostKeyChecking=no -o LogLevel=error -i "$TEMP_PRIVATE_KEY_FILE" "$USERNAME@$NEW_SERVER_IP_ADDRESS" <<ENDTEXT
rm -f .ssh/id_rsa
rm -f .ssh/id_rsa.pub
newkey
cat ~/.ssh/id_rsa.pub > ~/.ssh/authorized_keys
cat .ssh/id_rsa

sudo sed -i "s/password=.\+/password=$CYVISOR_SAMBA_PASSWORD/" /etc/samba/user
echo "//$CYVISOR_PUBLIC_DNS/cycligent /usr/share/cycligent cifs credentials=/etc/samba/user 0 0" | sudo tee --append /etc/fstab > /dev/null
sudo mount -a
ENDTEXT

rm "$TEMP_PRIVATE_KEY_FILE"
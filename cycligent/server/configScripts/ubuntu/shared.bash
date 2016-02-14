#!/usr/bin/env bash

make_temp_private_key_file() {
    local PRIVATE_KEY=$1
    local TEMP_PRIVATE_KEY_FILE=$(mktemp)
    echo "$PRIVATE_KEY" > "$TEMP_PRIVATE_KEY_FILE"
    echo "$TEMP_PRIVATE_KEY_FILE"
}
#!/bin/bash

# Define the paths
downloads_dir="/path/to"
ogs_data_dir="$downloads_dir/ogs_data"
jsonlet_dir="$downloads_dir/jsonlet"

# Create the ogs_data directory if it doesn't exist
mkdir -p "$ogs_data_dir"

# Clear the ogs_data directory - safer approach
find "$ogs_data_dir" -mindepth 1 -delete 2>/dev/null

# Clear the jsonlet directory - safer approach
find "$jsonlet_dir" -mindepth 1 -delete 2>/dev/null

# Move .json files to jsonlet
find "$downloads_dir" -maxdepth 1 -name "*.json" -print0 | xargs -0 -I {} mv {} "$ogs_data_dir"

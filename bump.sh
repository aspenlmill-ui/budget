#!/bin/sh
# Stamp a new build so open copies of the app reload themselves.
B=$(date +%Y%m%d%H%M)
sed -i "s/^const BUILD=\"[0-9]*\";/const BUILD=\"$B\";/" index.html
echo "$B" > version.txt

#!/bin/bash

set -e

envFile=$1

echo Using environment: $envFile

for i in ./bots/*.json; do
  echo Bullding bot: $i
  node deploy_lex_bot.js $i $envFile
done

#!/bin/bash
# Oracle Free sizes its SGA to ~1.6 GB by default (~1 GB buffer cache), and with
# automatic SGA management it grows the buffer cache into any free SGA space.
# Switch to manual SGA sizing so the buffer cache is exactly CACHE_MB like the other
# databases, then restart the instance so the spfile values take effect.
set -e
CACHE_MB=${CACHE_MB:-256}
sqlplus -s / as sysdba <<SQL
whenever sqlerror exit failure
alter system set sga_target = 0 scope = spfile;
alter system set memory_target = 0 scope = spfile;
alter system set sga_max_size = $((CACHE_MB + 512))M scope = spfile;
alter system set db_cache_size = ${CACHE_MB}M scope = spfile;
alter system set shared_pool_size = 384M scope = spfile;
alter system set large_pool_size = 16M scope = spfile;
alter system set java_pool_size = 0 scope = spfile;
shutdown immediate
startup
SQL

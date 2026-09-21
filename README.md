# database-id-benchmark

자동 생성 ID 17종(auto increment, Snowflake, UUID v1/v3/v4/v5/v6/v7, ULID, CUID v1/v2, NanoID,
ObjectId, KSUID, XID, TypeID 등)을 PK로 썼을 때, DB별로 **삽입 속도 · 용량 · 조회 속도**가
어떻게 달라지는지 재는 벤치마크입니다.

대상 DB: PostgreSQL, MySQL, MariaDB, Oracle, SQL Server, SQLite(rowid / WITHOUT ROWID)

## 실행

호스트에는 **Docker만** 있으면 됩니다. Node.js와 라이브러리는 전부 컨테이너 안에서 돌아갑니다.

```bash
./bench.sh                                   # 전체 (기본 설정, 몇 시간 걸림)
SIZES=10,100,1000 LOOKUPS=200 ./bench.sh     # 빠른 동작 확인
DBS="postgres mysql" ./bench.sh              # 일부 DB만
```

**Windows**에서는 WSL2(Ubuntu) 터미널에서 실행하세요. Git Bash에서도 돌아가긴 해요. Docker Desktop이 WSL2 백엔드를 쓰고 있어야 해요. x86 PC에서는 SQL Server도 에뮬레이션 없이 네이티브로 돌아요.

실행 전에 Docker Desktop 설정 → Resources에서 **메모리를 8GB 이상**으로 잡아 주세요. DB 하나(2GB)와 실행기(2GB)가 동시에 떠요.

결과는 `results/<RUN_ID>/`에 쌓입니다.

- `<db>.json`: 원본 측정값. 측정이 하나 끝날 때마다 저장되므로, 도중에 멈춰도 그때까지의 결과는 남습니다.
- `REPORT.md`: DB별 표
- `summary.csv`: 그래프용. DB × ID × 건수마다 한 줄입니다.

### 설정 (환경 변수)

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `DBS` | 전부 | `postgres mysql mariadb oracle mssql sqlite sqlite_norowid` |
| `TYPES` | 17종 전부 | 쉼표로 구분, `src/ids.js`의 키 |
| `SIZES` | `10,…,10000000` | 테이블 행 수 |
| `BIG_N` / `BIG_TYPES` | `10000000` / `autoinc,uuidv4,uuidv7,ulid,cuid2` | `BIG_N` 이상 건수에서는 이 ID들만 실행해요. 시간을 줄이려는 설정이에요. |
| `BATCH` | `1000` | INSERT 한 번에 넣는 행 수 |
| `LOOKUPS` | `20000` | 조회 횟수 (ID, email 각각) |
| `CACHE_MB` | `256` | DB 캐시 크기 |
| `CONC_WORKERS` / `CONC_ROWS` | `16` / `100000` | 동시 삽입 연결 수 / 행 수. `CONC_WORKERS=0`이면 건너뜀 |

## 무엇을 재나

### 테이블

ID 종류마다 `users_<종류>` 테이블을 만들고, 측정이 끝나면 지웁니다.

```sql
id            <ID별 타입>   primary key
email         varchar(255)  unique
name          varchar(100)
password_hash varchar(255)  -- bcrypt 모양의 60자 문자열
status        varchar(20)   default 'active'
created_at    timestamp     default now(), 인덱스
updated_at    timestamp     default now()
```

보조 인덱스를 두 개 넣은 이유가 있어요. InnoDB와 SQL Server는 보조 인덱스마다 PK를 같이 저장해서, ID가 길면 보조 인덱스도 함께 커지기 때문이에요.

### ID별 저장 타입

| ID | PostgreSQL | MySQL | MariaDB | Oracle | SQL Server | SQLite |
| --- | --- | --- | --- | --- | --- | --- |
| auto increment | `bigint identity` | `bigint auto_increment` | 〃 | `number(19) identity` | `bigint identity` | `integer` (rowid) |
| Snowflake | `bigint` | `bigint` | `bigint` | `number(19)` | `bigint` | `integer` |
| UUID v1·v3·v4·v5·v6·v7 | `uuid` | `binary(16)` | `uuid` | `raw(16)` | `uniqueidentifier` | `blob` |
| UUID v4 (varchar), ULID, CUID, CUID2, NanoID, ObjectId, KSUID, XID, TypeID | `varchar(n)` | `varchar(n)` | `varchar(n)` | `varchar2(n)` | `varchar(n)` | `text` |

- UUID v3/v5는 각 행의 email로 만듭니다.
- SQLite `WITHOUT ROWID`는 auto increment를 지원하지 않아서 그 조합은 건너뜁니다.

### 측정 항목

행 수(`SIZES`)마다, ID 종류마다 다음을 잽니다.

1. **삽입**: `BATCH`건씩 여러 행을 한 문장으로 넣어요. 연결은 하나이고 autocommit이에요. 전체 속도와 함께 10% 구간마다 속도를 기록해서, 테이블이 커질수록 느려지는지 봐요.
2. **용량**: 테이블과 인덱스를 나눠서 재요.
   - PostgreSQL: `pg_table_size` / `pg_indexes_size`
   - InnoDB: `data_length`(PK 포함) / `index_length`
   - Oracle: `user_segments`
   - SQL Server: `dm_db_partition_stats`
   - SQLite: `dbstat`
3. **ID로 조회, email로 조회**: 이미 있는 행을 무작위로 골라 `LOOKUPS`번 조회해요. 워밍업 1,000번 후에 재요.
   - 클라이언트에서 잰 p50/p95/p99
   - DB가 기록한 실행 시간과 디스크 읽기 수

     | DB | 출처 |
     | --- | --- |
     | PostgreSQL | `pg_stat_statements` |
     | MySQL/MariaDB | `performance_schema.prepared_statements_instances` + `Innodb_buffer_pool_reads` |
     | Oracle | `v$sql` |
     | SQL Server | `sys.dm_exec_query_stats` |
     | SQLite | 같은 프로세스 안에서 돌아서 클라이언트 시간이 곧 엔진 시간이에요. |
4. **동시 삽입**: 빈 테이블에 `CONC_WORKERS`개 연결이 한 건씩(autocommit) `CONC_ROWS`건을 넣어요. 순차 ID는 쓰기가 맨 오른쪽 페이지 한 곳에 몰려서 경합이 생길 수 있어요. 그 영향을 확인하는 측정이에요. SQLite는 쓰기가 한 번에 하나뿐이라 제외해요.
5. **환경 확인**
   - DB마다 시작 전후로 같은 CPU 계산을 3초 돌려서 속도가 변하지 않았는지 봐요.
   - 마지막에 첫 번째 측정(100만 건 이하 중 가장 큰 것)을 한 번 더 돌려서 처음과 비교해요.

### 공정하게 하려고 한 것

- **DB는 한 번에 하나씩** 띄웁니다. 여러 DB를 동시에 돌리면 CPU의 공유 캐시와 메모리 대역폭을 서로 뺏어서, 메모리를 많이 읽는 작업이 5~10배 느려지는 것을 미리 확인했어요.
- DB 컨테이너는 모두 **CPU 2개, 메모리 2GB, 캐시 `CACHE_MB`**로 맞춰요. 2개로 잡은 이유는 Oracle Free가 2스레드로 제한되기 때문이에요.
  - SQL Server는 버퍼만 따로 제한하는 설정이 없어서 `max server memory`로 근사치를 맞춰요.
  - Oracle은 SGA 자동 관리를 끄고 `db_cache_size`를 고정해요(`docker/oracle-init/`).
- 실행기(runner)도 Docker 안에서 같은 네트워크로 붙어요. SQLite는 실행기 안에서 돌기 때문에 실행기도 CPU 2개, 메모리 2GB로 제한해요. SQLite 파일은 호스트 폴더가 아니라 Docker 볼륨에 둬요.
- ID는 `src/gen.js`가 **미리 한 번만** 만들어 `cache/`에 저장해요. 모든 DB에 같은 ID가 들어가고, 삽입 시간에 ID 생성 비용은 포함되지 않아요. 생성 속도는 따로 기록해요.
- 이미지는 digest로 고정해서, 누가 돌려도 같은 빌드를 받아요.

### 한계

- **같은 DB 안에서 ID끼리 비교**하는 용도예요. DB끼리 빠르기를 비교하는 벤치마크가 아니에요. DB마다 설정, 내구성 기본값, 드라이버가 다르기 때문이에요.
- macOS와 Docker Desktop에서는 프로세스를 특정 CPU 코어에 고정할 수 없어요. 그래서 위의 CPU 확인 측정으로 대신해요.
- SQL Server는 ARM용 이미지가 없어서, Apple Silicon에서는 x86 에뮬레이션(Rosetta)으로 돌아요.
- ID를 짧은 시간에 몰아서 만들기 때문에, 시간 기반 ID의 시간 값이 실제 서비스보다 촘촘해요. `ulid` 패키지는 같은 밀리초 안에서는 순서를 보장하지 않아요.
- 각 측정은 1회예요.

## 파일 구성

```
bench.sh              전체 실행 (ID 생성 → DB 하나씩 → 리포트)
docker-compose.yml    DB와 실행기 컨테이너 (버전·자원 고정)
docker/oracle-init/   Oracle 캐시 크기 설정
src/ids.js            ID 17종 생성기
src/gen.js            ID를 미리 만들어 cache/에 저장
src/config.js         환경 변수 설정
src/bench.js          DB 하나에 대해 전체 측정
src/adapters/*.js     DB별 테이블 생성, 삽입, 용량, 조회, 서버 통계
src/report.js         REPORT.md, summary.csv 생성
results/_prelim/      초기 실험 결과 (구버전 코드, 참고용)
```

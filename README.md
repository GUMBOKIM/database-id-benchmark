# database-id-benchmark

많이 쓰는 자동 생성 ID 7종(auto increment, Snowflake, UUID v4, UUID v7, ULID, NanoID, CUID2)을
users 테이블의 PK로 썼을 때 **한 건 삽입 · ID 조회 · 용량**이 어떻게 달라지는지 재는 벤치마크입니다.

**같은 DB 안에서 ID끼리 비교**하는 용도예요. DB끼리 빠르기를 비교하는 벤치마크가 아니에요.
지금은 PostgreSQL을 대상으로 하고, MySQL도 같은 코드로 돌릴 수 있어요.

## 실행

호스트에는 **Docker만** 있으면 됩니다. Node.js와 라이브러리는 전부 컨테이너 안에서 돌아갑니다.
CPU 고정과 I/O 제한이 실제 하드웨어에 걸리도록 **네이티브 Docker Engine**(`docker context use default`)에서 돌리세요.
Docker Desktop은 켜질 때 현재 컨텍스트를 자기 VM으로 되돌려요. 그래서 실행 전에 `docker context show`가 `default`인지 확인하세요. Docker Desktop이면 `bench.sh`가 시작할 때 경고를 띄워요.
기본값은 개발 PC(Ryzen 9 7950X, `/dev/nvme1n1`)에 맞춰져 있어요. 다른 PC에서는 `DB_CPUS`, `RUNNER_CPUS`를 바꿔 주세요.

```bash
sudo scripts/host-prep.sh on        # (선택) 클럭 고정, 페이지 캐시 비우기
N_MAX=10000 ./bench.sh              # 동작 확인, 몇 분
REPS="1 2 3" ./bench.sh             # 본 측정 3회, PostgreSQL 회차당 약 1시간 10분
RUN_ID=<위 실행> REPS="4" ./bench.sh # 같은 실행에 반복 측정 추가
                                    # 같은 실행에 반복 측정 추가
DBS="postgres mysql" ./bench.sh     # MySQL도 함께
sudo scripts/host-prep.sh off       # 원래대로
```

결과는 `results/<RUN_ID>/`에 쌓입니다.

- `<db>.r<반복>.json`: 원본 측정값. 측정 지점마다 저장되므로, 도중에 멈춰도 그때까지의 결과는 남습니다.
- `report.html`: DB별 그래프. x축은 행 수(log)이고, 반복했다면 중앙값 선과 최소~최대 띠로 그려요.
- `summary.csv`: DB × 반복 × ID × 측정 지점마다 한 줄입니다.
- `host.json`: 측정한 PC의 CPU, 메모리, 디스크, OS와 **실제로 쓴 Docker 엔진**(네이티브 / Docker Desktop VM). 리포트 맨 위 "측정 환경" 표로 보여요.

### 설정 (환경 변수)

| 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `DBS` | `postgres` | `postgres mysql mariadb` |
| `REPS` | `1` | 반복 번호 목록. `"1 2 3"`이면 세 번, 매번 새 컨테이너 |
| `TYPES` | 7종 | 쉼표로 구분, `src/ids.js`의 키. uuidv1, uuidv6, uuidv4_str, typeid 등도 있어요 |
| `N_MIN` / `N_MAX` | `1000` / `10000000` | 측정 지점 범위 |
| `POINTS_PER_DECADE` | `10` | 10배 구간마다 측정 지점 수 (log 간격) |
| `SINGLE_W` | `1000` | 측정 지점마다 한 건씩 넣으며 재는 행 수 |
| `READ_N` / `READ_WARMUP` | `5000` / `500` | 조회 패턴마다 조회 수 / 워밍업 |
| `RECENT_FRAC` / `RECENT_SHARE` | `0.1` / `0.9` | 최근 편중 조회: 90%를 최근 10% 행에서 |
| `COLD_W` / `COLD_READ_N` | `200` / `1000` | 캐시를 비운 직후 한 건 삽입 수 / 조회 패턴마다 조회 수 |
| `CONC_WORKERS` / `CONC_ROWS` / `CONC_MIN_N` | `16` / `8000` / `100000` | 동시 삽입 연결 수 / 행 수 / 시작 지점. `CONC_WORKERS=0`이면 건너뜀 |
| `SIM_DAYS` | `365` | 시간 기반 ID의 가입 시각을 퍼뜨리는 기간 |
| `DB_CPUS` / `RUNNER_CPUS` | `0-7,16-23` / `8-15,24-31` | CPU 고정. 7950X의 CCD 두 개에 나눠서 L3 캐시도 따로 써요 |
| `BATCH` | `1000` | 측정 지점 사이를 채울 때 INSERT 한 번에 넣는 행 수 |

## 무엇을 재나

### 테이블

ID 종류마다 `users_<종류>` 테이블을 만들고, 측정이 끝나면 지웁니다.

```sql
id            <ID별 타입>   primary key
account       varchar(50)   unique      -- 로그인 아이디
password_hash varchar(255)              -- bcrypt 모양의 60자 문자열
name          varchar(50)               -- 한글 이름
phone_number  varchar(20)               -- 010-XXXX-XXXX
email         varchar(255)  unique
created_at    timestamp     default now()
updated_at    timestamp     default now()
```

`account`와 `email`은 해시로 시작해서, ID 종류와 상관없이 무작위 순서로 들어가요. 실제 가입 순서와 같아요.

### ID별 저장 타입

| ID | PostgreSQL | MySQL | 정렬 |
| --- | --- | --- | --- |
| auto increment | `bigint identity` | `bigint auto_increment` | ✅ |
| Snowflake | `bigint` | `bigint` | ✅ |
| UUID v7 | `uuid` | `binary(16)` | ✅ |
| UUID v4 | `uuid` | `binary(16)` | ❌ |
| ULID (monotonic) | `varchar(26)` | `varchar(26)` | ✅ |
| NanoID, CUID2 | `varchar(21)`, `varchar(24)` | 〃 | ❌ |

`TYPES`로 고를 수 있는 나머지(UUID v1/v6, UUID v4 varchar, TypeID 등)도 같은 규칙이에요. UUID v1은 시간 기반이지만 시간의 하위 비트가 앞에 와서 바이트 순서로는 정렬되지 않아요.

### 측정 방식

테이블 하나를 빈 상태에서 `N_MAX`까지 키우면서, **10배 구간마다 10개**(1000, 1260, 1580, 2000, …)의 측정 지점에서 멈춰서 잽니다.
측정 지점 N마다 다음 순서로 진행해요.

1. **채우기**: 이전 지점부터 N − `SINGLE_W`까지 `BATCH`건씩 묶어서 넣어요. 처리량은 참고용으로만 기록해요.
2. **한 건 삽입**: 마지막 `SINGLE_W`건을 한 건씩 prepared statement와 autocommit으로 넣고, 한 건마다 지연을 재요. 실제 서비스의 가입 요청 하나와 같은 모양이에요.
3. **용량**: 테이블과 인덱스를 나눠서 재요 (PostgreSQL `pg_table_size` / `pg_indexes_size`, MySQL은 `ANALYZE TABLE` 후 `data_length` / `index_length`).
4. **ID 조회, 균등**: 0~N 중에서 무작위로 골라 `SELECT * WHERE id = ?`를 `READ_N`번 해요.
5. **ID 조회, 최근 편중**: 조회의 90%는 최근 10% 행에서 골라요. 정렬되는 ID는 최근 행이 인덱스 끝에 모여 캐시에 남지만, 랜덤 ID는 흩어져 있어요.

1과 2에서는 **WAL 양**(행당 바이트, 전체 페이지 기록 FPI 수)도 기록해요. 랜덤 ID는 체크포인트 뒤 매번 다른 인덱스 페이지를 처음 건드려서 FPI가 많이 생겨요.

**10배 지점**(1천, 1만, …, 1천만)에서는 다음을 더 재요.

- **동시 삽입** (10만 건 이상): 16개 연결이 한 건씩 동시에 8,000건을 넣어요. 정렬되는 ID는 인덱스 맨 끝 페이지에 삽입이 몰려서 경합이 생길 수 있어요.
- **캐시를 비운 직후**: `pg_buffercache_evict_all()`로 PostgreSQL 버퍼를, `/proc/sys/vm/drop_caches`로 OS 페이지 캐시를 비운 뒤 한 건 삽입 200번을 재요. 조회도 패턴마다 캐시를 다시 비우고 워밍업 없이 1,000번 재요. 끝나면 `pg_prewarm`으로 테이블과 인덱스를 OS 캐시에 다시 읽어 들여서, 다음 측정 지점이 영향을 받지 않게 해요.
- **PK 인덱스 상태**: `pgstatindex()`로 리프 페이지 평균 채움률과 단편화를 재요.

조회는 클라이언트 지연(p50/p95/p99)과 함께 DB가 기록한 값도 남겨요.

| DB | 출처 |
| --- | --- |
| PostgreSQL | `pg_stat_statements`: 서버 실행 시간, 캐시(`shared_buffers`) 밖에서 읽은 블록 수 |
| MySQL | `performance_schema.prepared_statements_instances`, `Innodb_buffer_pool_reads` |

리포트의 조회 그래프는 **서버 실행 시간**을 주로 봐요. 클라이언트 지연에는 ID와 상관없는 왕복 시간이 섞여서 차이를 가려요.

### 환경

| 항목 | 설정 | 근거 |
| --- | --- | --- |
| DB 설정 | 전부 기본값 (PostgreSQL `shared_buffers` 128MB, InnoDB 버퍼 풀 128MB) | 통계 수집(`pg_stat_statements`, `performance_schema`)만 켜요 |
| 메모리, 디스크 I/O | 제한 없음 | |
| CPU | DB와 실행기를 서로 다른 CCD에 고정 | CPU 캐시를 서로 뺏지 않게 |
| DB 실행 | 한 번에 하나씩, 반복마다 새 컨테이너 | |

메모리 제한이 없어서, 이 PC(61GB)에서는 1천만 행(약 3GB)이 전부 OS 페이지 캐시에 들어가요.
그래서 DB 버퍼(128MB)를 넘은 뒤에는 **OS 캐시에서 읽는 비용**까지 보이고, 디스크까지 가는 비용은 보이지 않아요.
메모리가 데이터보다 넉넉한 서버와 같은 상황이에요. 조회 그래프의 "캐시 밖 읽기"는 DB 버퍼 밖에서 읽은 블록 수예요.

ID는 `src/gen.js`가 **미리 한 번만** 만들어 `cache/`에 저장해요. 모든 DB와 반복에 같은 ID가 들어가고, 삽입 시간에 ID 생성 비용은 포함되지 않아요.
시간 기반 ID(Snowflake, UUID v7, ULID 등)는 실제 가입처럼 **1천만 명이 1년에 걸쳐 가입한 시각**(고정 시드, 지수 분포 간격)을 넣어 만들어요. 몰아서 만들면 시간값이 몇 초 안에 모여서 실제와 다르게 동작하기 때문이에요 (예: UUID v1이 정렬된 것처럼 보임).

ID 종류는 반복마다 다른 순서로 측정해요(반복 번호로 시드). 측정 시각에 따라 디스크의 커밋 속도가 변해서, 순서가 같으면 뒤쪽 ID만 불리해지기 때문이에요.

## 한계

- Docker Desktop(VM)에서는 CPU 고정이 가상 CPU에 걸려서 의미가 없고, 커밋이 VM 디스크를 거쳐 느리고 들쭉날쭉해요(약 1.6~2.7ms). 네이티브 엔진을 쓰세요.
- 한 건 삽입 지연의 대부분은 커밋(WAL 기록) 시간이에요. 그래서 커밋을 뺀 **서버 실행 시간**도 따로 기록해요. ID 차이는 주로 여기서 보여요.
- DB마다 시작 전후로 같은 CPU 계산을 3초 돌려서, 측정 중에 CPU 속도가 변하지 않았는지 봐요.
- 데이터가 메모리보다 커서 디스크를 읽어야 하는 상황은 재지 않아요. 그런 서버라면 랜덤 ID의 손해가 이 결과보다 커요.
- 캐시를 비운 측정은 로컬 NVMe에서 읽어요. RDS의 EBS는 읽기 한 번이 더 느려서, 실제 차이는 이 결과보다 커요.
- 실행기 컨테이너는 OS 캐시를 비우려고 `privileged`로 떠요. OS 캐시 비우기는 PC 전체에 적용돼요.
- 동시 삽입 말고는 연결 하나에서 순서대로 해요.

## 파일 구성

```
bench.sh                  전체 실행 (ID 생성 → DB 하나씩 × 반복 → 리포트)
docker-compose.yml        DB와 실행기 컨테이너 (버전, CPU 고정)
scripts/host-prep.sh      호스트 클럭 고정, 페이지 캐시 비우기 (sudo)
scripts/host-info.sh      측정 환경을 JSON으로 기록 (bench.sh가 host.json으로 저장)
src/ids.js                ID 생성기
src/gen.js                ID를 미리 만들어 cache/에 저장
src/config.js             환경 변수 설정, 측정 지점 계산
src/bench.js              DB 하나에 대해 전체 측정
src/adapters/*.js         DB별 테이블 생성, 삽입, 용량, 조회, 서버 통계
src/report.js             summary.csv, report.html 생성
src/report-template.html  report.html의 틀
results/_prelim/          초기 실험 결과 (구버전 코드, 참고용)
```

# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take}.ts        # 4 个数据模型
        ├── stores/{shotStore,frameStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v3 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/props` | 道具位移轨迹 | **规划来源页**：按镜头与帧区间登记道具终点绝对位姿（X/Y/Z/旋转），保存/删除后从该段起点重算帧序；表格显示逐帧绝对位置、相邻位移与已实拍/待补拍标记，场记确认后才推进镜头进度 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数；帧粒度的场记确认也计入完成度 |

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录四张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；
  `v4` 把道具绝对位姿确立为唯一规划来源：`frames` 增加 `planPose`（逐道具逐帧绝对位姿）、`shotTaken`/`takenAt`/`takenCount` 字段，
  `props` 增加 `system` 标记。旧库升级时把每帧标量位移沿 X 轴累计回填 `planPose`，并生成系统占位区间「旧轨迹」，
  使升级后的逐帧位置、相邻位移与累计曲线与升级前完全一致。

## 道具轨迹 → 帧序的规划口径

- 道具轨迹（`props`）按帧区间登记**终点绝对位姿**，是唯一规划来源；同道具下一段自动承接上一段终点，段前/段后保持、段内逐帧线性插值。
- 保存或删除区间后，**从该段起点**（编辑时取旧/新起点较早值）在一个 Dexie 事务里重算 `frames`：写入逐帧 `planPose`，回写相邻位移 `propOffsetMm`；校验失败或写库失败时整事务回滚，页面状态也恢复到动手前。
- 已实拍帧（`shotTaken=true`）的计划不被覆盖；若新计划与已拍帧位姿不一致，页面标出**最早需要补拍的帧号**（补拍横幅 + 条带红边）。
- **场记确认补拍完成**后，才把补拍区间按当前轨迹固化为实拍结果并回写镜头进度；原有 `takes` 实拍记录始终保留。
- 逐帧相邻位移（条带 Δ、编排台、逐帧表）统一由 `utils/propPlan.ts` 的 `deltaAgainst` 从绝对位姿差算出，不再手工录入。
- **localStorage**：新建镜头表单与批量曝光参数草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。

# CLAUDE.md - AgileLens (MVP)

## 概要

AgileLens は、GitHub のリポジトリと連携し、Issue のカンバン管理および EVM（アーンドバリューマネジメント）による進捗可視化を自動化するツールです。

MVP フェーズでは、Supabase（PostgreSQL）をバックエンドに採用し、ローカル作業の実態に合わせた柔軟な運用と、最短での価値検証を目指します。

---

## 1. 画面一覧 (Screens)

画面遷移を最小限にするため、サイドバーとヘッダーを持つ共通レイアウト（ダッシュボード）をベースに構築します。

### 共通レイアウト (Layout)

- **サイドバー:** 連携済みプロジェクト（GitHub リポジトリ）の一覧。クリックでプロジェクト切り替え。最下部に「＋ リポジトリ追加」ボタンを配置する。ここで初回登録および `CLAUDE.md` からのタスク自動生成を実行する。
- **ヘッダー:** 選択中のプロジェクト名と、「アジャイルボード」「EVMアナリティクス」を切り替えるタブ（トグル）を配置する。設定ボタンも配置し、時給やポイント単価を登録できるようにする。

### `/login` (ログイン画面)

- GitHub OAuth によるサインインボタンのみのミニマルな構成。

### `/projects/[id]/board` (アジャイルボード画面)

- GitHub Issue を「Backlog」「In Progress」「Done」の 3 カラムで表示するカンバンボード。
- ヘッダー付近に **「＋ タスク追加」ボタン** を設置する。コーディング以外のタスクを手動で Issue 化するために使用する。
- ドラッグ＆ドロップによるステータス変更に対応する。UI 側で動かすと同時に、バックエンドから GitHub のラベルへ反映する。
- 各カードには「Issue タイトル」「担当者アイコン」「Story Point」を表示する。

### `/projects/[id]/analytics` (EVMアナリティクス画面)

- スプリント（GitHub Milestone）を切り替えるドロップダウンを配置する。
- **「本日の稼働時間入力」フォーム:** 画面上部に `[稼働時間] 時間` `[登録]` フォームを設置し、日々の AC 計算のトリガーとする。
- EVM 推移グラフ（PV/EV/AC の 3 本線）を `Recharts` で描画する。
- 現在のベロシティと予測完了日のサマリーを表示する。

---

## 2. テーブル設計 (Database Schema)

バックエンドは Supabase（PostgreSQL）を使用します。EVM 計算に必要な「時給」「単価」や「稼働時間」のフィールドに加えて、GitHub 同期、手動タスク、スプリント周期、検索性能、RLS を考慮した設計にします。

正式な初期DDLは `supabase/migrations/20260706000000_initial_schema.sql` に配置します。以下は主要テーブルの設計方針です。

### 2-1. 補強方針

- UUID は `gen_random_uuid()` を使用する。
- 全主要テーブルに `created_at` と `updated_at` を持たせる。
- `updated_at` は trigger で自動更新する。
- GitHub 同期対象のテーブルには `synced_at` を持たせる。
- `issues` には GitHub ラベルキャッシュ用の `labels JSONB` を持たせる。
- `issues` には `source` を持たせ、`github` / `manual` / `claude` を区別する。
- `sprints` には `cycle_days` を持たせ、画面上のスプリント周期設定に対応する。
- `kanban_column` は `Backlog` / `In Progress` / `Done` に制約する。
- `state` は GitHub の `open` / `closed` に合わせる。
- 検索頻度が高い `repository_id`、`sprint_id`、`kanban_column`、`recorded_date` には index を付与する。
- MVP の RLS は「リポジトリ登録ユーザーが所有するデータにアクセス可能」を基本とする。
- GitHub コラボレーター権限の厳密な確認は、DB の RLS だけではなくサーバー側で GitHub API に問い合わせて判定する。

### 2-2. 主要テーブル

```sql
-- 1. ユーザー管理 (Supabase Auth連携)
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    github_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    github_access_token TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. 連携リポジトリ (EVMの設定値である単価と時給を保持)
CREATE TABLE public.repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    github_repo_id TEXT UNIQUE NOT NULL,
    repo_name TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    full_name TEXT GENERATED ALWAYS AS (owner_name || '/' || repo_name) STORED,
    hourly_wage INT DEFAULT 0 NOT NULL,
    point_unit_price INT DEFAULT 0 NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. スプリント情報 (GitHub Milestone同期)
CREATE TABLE public.sprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES public.repositories(id) ON DELETE CASCADE,
    github_milestone_id TEXT,
    title TEXT NOT NULL,
    start_date DATE,
    due_on DATE,
    cycle_days INT DEFAULT 14 NOT NULL,
    state TEXT DEFAULT 'open' NOT NULL,
    total_story_points INT DEFAULT 0 NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (repository_id, github_milestone_id)
);

-- 4. タスク情報 (GitHub Issue同期)
CREATE TABLE public.issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES public.repositories(id) ON DELETE CASCADE,
    sprint_id UUID REFERENCES public.sprints(id) ON DELETE SET NULL,
    github_issue_id TEXT,
    github_issue_number INT,
    title TEXT NOT NULL,
    state TEXT DEFAULT 'open' NOT NULL,
    kanban_column TEXT DEFAULT 'Backlog' NOT NULL,
    story_point INT DEFAULT 0 NOT NULL,
    labels JSONB DEFAULT '[]'::jsonb NOT NULL,
    source TEXT DEFAULT 'github' NOT NULL,
    assignee_username TEXT,
    assignee_avatar_url TEXT,
    github_html_url TEXT,
    closed_at TIMESTAMP WITH TIME ZONE,
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (repository_id, github_issue_id),
    UNIQUE (repository_id, github_issue_number)
);

-- 5. EVM時系列スナップショット (日々の稼働時間入力と連動して作成/更新)
CREATE TABLE public.evm_daily_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sprint_id UUID NOT NULL REFERENCES public.sprints(id) ON DELETE CASCADE,
    recorded_date DATE NOT NULL,
    planned_value INT DEFAULT 0 NOT NULL,
    earned_value INT DEFAULT 0 NOT NULL,
    actual_cost INT DEFAULT 0 NOT NULL,
    daily_working_hours NUMERIC(5,2) DEFAULT 0 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (sprint_id, recorded_date)
);
```

### 2-3. Index / Constraint / RLS

- `repositories(user_id)`、`repositories(full_name)` に index を付与する。
- `sprints(repository_id)`、`sprints(repository_id, state)` に index を付与する。
- `issues(repository_id)`、`issues(sprint_id)`、`issues(repository_id, sprint_id, kanban_column)` に index を付与する。
- `issues.labels` は `GIN` index を付与する。
- `evm_daily_snapshots(sprint_id, recorded_date)` に index と unique 制約を付与する。
- 金額、Story Point、稼働時間は 0 以上に制約する。
- RLS は全テーブルで有効化する。
- `auth.uid()` と `repositories.user_id` を基準に所有データへのアクセスを許可する。

---

## 3. 処理フロールール (Workflows & Rules)

システムのデータ整合性を保つためのルールおよび同期フローです。

### 3-1. タスク生成と同期フロー (GitHub / Supabase)

#### 初回登録時の自動生成

- システムに GitHub リポジトリを追加したタイミングで、対象リポジトリ内の `CLAUDE.md` 等の定義ファイルを読み込む。
- 読み込んだ定義ファイルからリスト化されたタスクを抽出し、GitHub Issue として自動生成する。

#### 手動追加

- コーディング以外のタスク（デザイン、ドキュメント等）を管理するため、アジャイルボード画面から手動でタスク（Issue）を作成可能とする。
- 手動追加時は、アプリから GitHub API 経由で Issue を作成する。

#### ステータス同期（一方向影響の原則）

- **アプリから GitHub へ:** アジャイルボード上でカードを移動（手動操作）した場合、GitHub 側の「ラベル」のみを更新する。例: `status: in-progress`。コードや Pull Request の State には直接影響を与えない。
- **GitHub からアプリへ:** GitHub 上で Pull Request が `main` にマージされ Issue が Closed になったイベントを検知し、アプリ側のカンバンで該当タスクを自動的に「Done（完了）」列へ移動させる。

#### ローカル作業のステータス管理

- Pull Request 作成前のローカル作業中は自動検知が難しい。
- 作業開始時にユーザー自身がアプリ上でタスクを「In Progress」へドラッグ＆ドロップする運用を正とする。

### 3-2. EVM（アーンドバリューマネジメント）算出ロジック

スプリント単位（例: 2 週間）でタスクの進捗を金銭的価値に換算してグラフ化する。

#### 前提設定

- タスクの重さを「Story Point（例: `sp:3`）」ラベルで定義する。
- プロジェクト（リポジトリ）設定にて「1 ポイントあたりの単価（予算）」および「ユーザーの時給」を定義しておく。

#### PV (Planned Value / 計画価値)

- `(スプリント内の総ポイント数) * (1ポイントあたりの単価)` を総予算とする。
- スプリント期間内で均等に消化していく理想線を引く。

#### EV (Earned Value / 獲得価値)

- `(完了列に移動したIssueの総ポイント数) * (1ポイントあたりの単価)` で算出する。
- Issue が完了した瞬間に、その日の EV として積み上げる。

#### AC (Actual Cost / 実績コスト)

- アナリティクス画面から「1 日の総作業時間」を入力する。
- `(作業時間) * (時給)` を計算する。
- 前日までの累積 AC に加算して、その日の AC として記録する。

---

## 4. ロール (Roles & Permissions)

MVP フェーズではアプリ独自の複雑な権限管理テーブルを持たず、GitHub の権限に依存するシンプルな構成とします。

### プロジェクトオーナー

- GitHub リポジトリの管理者、または本システムにリポジトリを新規登録したユーザー。
- 連携設定の解除、および EVM 算出のベースとなる「時給」「単価」の数値設定権限を持つ。

### コラボレーター

- 該当 GitHub リポジトリに Read/Write アクセスを持つ認証ユーザー。
- アプリへのログイン後、当該プロジェクトのアジャイルボード操作（ドラッグ＆ドロップ）が可能。
- EVM ダッシュボードの閲覧と稼働時間の入力が可能。

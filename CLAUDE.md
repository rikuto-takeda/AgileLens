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

バックエンドは Supabase（PostgreSQL）を使用します。EVM 計算に必要な「時給」「単価」や「稼働時間」のフィールドを追加しています。

```sql
-- 1. ユーザー管理 (Supabase Auth連携)
CREATE TABLE public.users (
    id UUID REFERENCES auth.users NOT NULL PRIMARY KEY,
    github_id VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    github_access_token TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. 連携リポジトリ (EVMの設定値である単価と時給を保持)
CREATE TABLE public.repositories (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    github_repo_id VARCHAR(255) UNIQUE NOT NULL,
    repo_name VARCHAR(255) NOT NULL,
    owner_name VARCHAR(255) NOT NULL,
    hourly_wage INT DEFAULT 0,       -- ユーザーの時給（AC算出用）
    point_unit_price INT DEFAULT 0,  -- 1 Story Pointあたりの単価（PV/EV算出用）
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. スプリント情報 (GitHub Milestone同期)
CREATE TABLE public.sprints (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    repository_id UUID REFERENCES public.repositories(id) ON DELETE CASCADE,
    github_milestone_id VARCHAR(255) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    start_date TIMESTAMP WITH TIME ZONE,
    due_on TIMESTAMP WITH TIME ZONE,
    state VARCHAR(50) DEFAULT 'open',
    total_story_points INT DEFAULT 0
);

-- 4. タスク情報 (GitHub Issue同期)
CREATE TABLE public.issues (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    repository_id UUID REFERENCES public.repositories(id) ON DELETE CASCADE,
    sprint_id UUID REFERENCES public.sprints(id) ON DELETE SET NULL,
    github_issue_id VARCHAR(255) UNIQUE NOT NULL,
    github_issue_number INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    state VARCHAR(50) DEFAULT 'open',
    kanban_column VARCHAR(50) DEFAULT 'Backlog',
    story_point INT DEFAULT 0,
    assignee_avatar_url TEXT,
    closed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. EVM時系列スナップショット (日々の稼働時間入力と連動して作成/更新)
CREATE TABLE public.evm_daily_snapshots (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sprint_id UUID REFERENCES public.sprints(id) ON DELETE CASCADE,
    recorded_date DATE NOT NULL,
    planned_value INT DEFAULT 0, -- PV: その日までに予定していた累積価値(金額)
    earned_value INT DEFAULT 0,  -- EV: その日までに完了した累積価値(金額)
    actual_cost INT DEFAULT 0,   -- AC: その日までの累積コスト(金額)
    daily_working_hours NUMERIC(5,2) DEFAULT 0, -- 画面から入力されたその日の稼働時間
    UNIQUE (sprint_id, recorded_date)
);
```

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

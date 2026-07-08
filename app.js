const initialRoute = parseRoute();

const state = {
  authChecking: true,
  authConfigured: true,
  authError: null,
  loggedIn: false,
  user: null,
  view: initialRoute.view,
  selectedRepoId: initialRoute.repoId || null,
  selectedSprintId: "sprint-1",
  selectedAnalyticsSprintId: "sprint-1",
  draggedIssueId: null,
  selectedIssueId: null,
  sidebarOpen: false,
  taskDialogOpen: false,
  pointDialogOpen: false,
  repoLoading: false,
  repoLoadError: null,
  repoDialogOpen: false,
  repoSaveBusy: false,
  repoSaveError: null,
  repoDeleteBusyId: null,
  githubRepoLoading: false,
  githubRepoLoadError: null,
  availableGithubRepos: [],
  issuesLoading: false,
  issuesLoadError: null,
  progressSyncing: false,
  progressSyncError: null,
  lastProgressSyncedAt: null,
  taskSaveBusy: false,
  issueSaveBusy: false,
  claudeTaskGenerating: false,
  claudeTaskError: null,
  repoForm: {
    github_repo_id: "",
  },
};

let repositories = [];

const sprints = [
  {
    id: "sprint-1",
    repository_id: "repo-1",
    title: "Sprint 1: MVP Foundation",
    start_date: "2026-07-06",
    due_on: "2026-07-19",
    cycle_days: 14,
  },
  {
    id: "sprint-2",
    repository_id: "repo-1",
    title: "Sprint 2: GitHub Sync",
    start_date: "2026-07-20",
    due_on: "2026-08-02",
    cycle_days: 14,
  },
  {
    id: "sprint-3",
    repository_id: "repo-2",
    title: "Sprint 1: Design Workflow",
    start_date: "2026-07-06",
    due_on: "2026-07-12",
    cycle_days: 7,
  },
  {
    id: "sprint-4",
    repository_id: "repo-3",
    title: "Sprint 1: Docs MVP",
    start_date: "2026-07-06",
    due_on: "2026-07-19",
    cycle_days: 14,
  },
];

let issues = [];

const evmData = [
  { day: "Day 1", pv: 12000, ev: 0, ac: 18000 },
  { day: "Day 2", pv: 24000, ev: 0, ac: 30000 },
  { day: "Day 3", pv: 36000, ev: 24000, ac: 43000 },
  { day: "Day 4", pv: 48000, ev: 60000, ac: 55000 },
  { day: "Day 5", pv: 60000, ev: 60000, ac: 70000 },
  { day: "Day 6", pv: 72000, ev: 96000, ac: 81000 },
  { day: "Day 7", pv: 84000, ev: 96000, ac: 92000 },
];

const app = document.querySelector("#app");

function currentRepo() {
  return repositories.find((repo) => repo.id === state.selectedRepoId) || repositories[0] || null;
}

function repoSprints() {
  return sprints.filter((sprint) => sprint.repository_id === state.selectedRepoId);
}

function currentSprint() {
  const availableSprints = repoSprints();
  return (
    availableSprints.find((sprint) => sprint.id === state.selectedSprintId) ||
    availableSprints[0]
  );
}

function ensureSprintSelection() {
  const repo = currentRepo();
  if (!repo) return;

  state.selectedRepoId = repo.id;
  ensureDefaultSprint(repo.id);

  const sprint = currentSprint();
  if (sprint) {
    state.selectedSprintId = sprint.id;
    if (
      state.selectedAnalyticsSprintId !== "all" &&
      !repoSprints().some((item) => item.id === state.selectedAnalyticsSprintId)
    ) {
      state.selectedAnalyticsSprintId = sprint.id;
    }
  }
}

function ensureDefaultSprint(repoId) {
  if (sprints.some((sprint) => sprint.repository_id === repoId)) return;

  const startDate = new Date().toISOString().slice(0, 10);
  sprints.push({
    id: `local-sprint-${repoId}`,
    repository_id: repoId,
    title: "Sprint 1",
    start_date: startDate,
    due_on: calculateDueDate(startDate, 14),
    cycle_days: 14,
  });
}

function routeTo(view) {
  state.view = view;
  if (!state.selectedRepoId) {
    render();
    return;
  }
  window.location.hash = `/projects/${state.selectedRepoId}/${view}`;
  render();
}

function render() {
  if (state.authChecking) {
    renderAuthLoading();
    return;
  }

  if (!state.loggedIn) {
    renderLogin();
    return;
  }

  ensureSprintSelection();
  const repo = currentRepo();
  app.innerHTML = `
    <div class="app-shell ${state.sidebarOpen ? "sidebar-open" : ""}">
      <button class="sidebar-backdrop" data-action="close-sidebar" aria-label="サイドバーを閉じる"></button>
      ${renderSidebar()}
      <main class="main">
        <header class="header">
          <div class="header-project">
            <button class="menu-button" data-action="toggle-sidebar" aria-label="サイドバーを開く">☰</button>
            <div class="project-title">
              <h2>${repo ? escapeHtml(repo.repo_name) : "リポジトリ未登録"}</h2>
              <span>${repo ? escapeHtml(repo.full_name || `${repo.owner_name}/${repo.repo_name}`) : "GitHub repository"}</span>
            </div>
          </div>
          <div class="header-actions">
            <div class="tabs" aria-label="画面切り替え">
              <button class="tab-button ${state.view === "board" ? "active" : ""}" data-view="board">アジャイルボード</button>
              <button class="tab-button ${state.view === "analytics" ? "active" : ""}" data-view="analytics">EVMアナリティクス</button>
            </div>
            ${renderUserMenu()}
          </div>
        </header>
        <section class="content">
          ${repo ? (state.view === "analytics" ? renderAnalytics() : renderBoard()) : renderRepositoryEmptyState()}
        </section>
      </main>
    </div>
    <div id="toast" class="toast hidden"></div>
    ${state.repoDialogOpen ? renderRepositoryDialog() : ""}
  `;

  bindDashboardEvents();
}

function renderAuthLoading() {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="loading-title">
        <div class="brand">
          <div class="brand-mark">AL</div>
          <h1 id="loading-title">AgileLens</h1>
          <p>認証状態を確認しています。</p>
        </div>
      </section>
    </main>
  `;
}

function renderLogin() {
  const loginError = state.authError || loginErrorMessage();
  const disabled = state.loginBusy || !state.authConfigured;

  app.innerHTML = `
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="login-title">
        <div class="brand">
          <div class="brand-mark">AL</div>
          <h1 id="login-title">AgileLens</h1>
          <p>GitHub IssueをカンバンとEVMで可視化するMVPダッシュボード</p>
        </div>
        ${loginError ? `<p class="login-message">${loginError}</p>` : ""}
        <button class="github-button" data-action="login" ${disabled ? "disabled" : ""}>
          <span aria-hidden="true">●</span>
          ${state.loginBusy ? "GitHubへ移動しています" : "GitHubでサインイン"}
        </button>
      </section>
    </main>
  `;

  document.querySelector("[data-action='login']").addEventListener("click", () => {
    state.loginBusy = true;
    render();
    window.location.href = "/auth/github";
  });
}

function renderUserMenu() {
  if (!state.user) return "";

  const rawUsername = state.user.username || "GitHub user";
  const username = escapeHtml(rawUsername);
  const avatar = state.user.avatar_url
    ? `<img src="${escapeHtml(state.user.avatar_url)}" alt="" />`
    : `<span>${username.slice(0, 2).toUpperCase()}</span>`;

  return `
    <div class="user-menu">
      <div class="user-avatar" title="${username}">${avatar}</div>
      <button class="logout-button" data-action="logout">ログアウト</button>
    </div>
  `;
}

function renderRepositoryEmptyState() {
  return `
    <section class="empty-state">
      <div class="empty-state-mark">＋</div>
      <h3>リポジトリを追加してください</h3>
      <p>GitHubリポジトリを登録すると、サイドバーからプロジェクトを切り替えられます。</p>
      <button class="primary-button" data-action="open-repo-dialog">リポジトリ追加</button>
      ${state.repoLoadError ? `<p class="form-error">${escapeHtml(state.repoLoadError)}</p>` : ""}
    </section>
  `;
}

function renderRepositoryDialog() {
  const selectableRepos = state.availableGithubRepos.filter((repo) => !repo.registered);
  const selectedRepoId =
    state.repoForm.github_repo_id || (selectableRepos[0] ? selectableRepos[0].id : "");

  return `
    <div class="modal-backdrop" data-action="close-repo-dialog">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="repo-dialog-title">
        <div class="modal-header">
          <h3 id="repo-dialog-title">リポジトリ追加</h3>
          <button class="icon-button modal-close" data-action="close-repo-dialog" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">
          ${
            state.githubRepoLoading
              ? '<div class="repo-loading">GitHubリポジトリを読み込んでいます</div>'
              : `
                <div class="repo-form">
                  <div class="field repo-full-name-field">
                    <label for="repo-github-id">GitHubリポジトリ</label>
                    <select id="repo-github-id" data-repo-field="github_repo_id" ${selectableRepos.length === 0 ? "disabled" : ""}>
                      ${
                        state.availableGithubRepos.length === 0
                          ? '<option value="">選択できるリポジトリがありません</option>'
                          : state.availableGithubRepos
                              .map(
                                (repo) => `
                                  <option value="${escapeHtml(repo.id)}" ${repo.id === selectedRepoId ? "selected" : ""} ${repo.registered ? "disabled" : ""}>
                                    ${escapeHtml(repo.full_name)}${repo.private ? " / private" : ""}${repo.registered ? " / 登録済み" : ""}
                                  </option>
                                `,
                              )
                              .join("")
                      }
                    </select>
                  </div>
                </div>
              `
          }
          <p class="form-note">時給とポイント単価は追加後に設定します。</p>
          ${state.githubRepoLoadError ? `<p class="form-error">${escapeHtml(state.githubRepoLoadError)}</p>` : ""}
          ${state.repoSaveError ? `<p class="form-error">${escapeHtml(state.repoSaveError)}</p>` : ""}
        </div>
        <div class="modal-footer">
          <button class="secondary-button" data-action="close-repo-dialog" ${state.repoSaveBusy ? "disabled" : ""}>キャンセル</button>
          <button class="primary-button" data-action="create-repo" ${state.repoSaveBusy || state.githubRepoLoading || selectableRepos.length === 0 ? "disabled" : ""}>
            ${state.repoSaveBusy ? "追加中" : "追加"}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">
          <span class="brand-mark">AL</span>
          <span>AgileLens</span>
        </div>
        <div class="sidebar-subtitle">GitHub repositories</div>
      </div>
      <nav class="repo-list" aria-label="プロジェクト一覧">
        ${
          repositories.length === 0
            ? '<div class="repo-empty">リポジトリ未登録</div>'
            : repositories
                .map(
                  (repo) => `
              <div class="repo-row ${repo.id === state.selectedRepoId ? "active" : ""}">
                <button class="repo-button" data-repo-id="${repo.id}">
                  <span class="repo-icon">${escapeHtml(repo.repo_name.slice(0, 2).toUpperCase())}</span>
                  <span>
                    <span class="repo-name">${escapeHtml(repo.repo_name)}</span>
                    <span class="repo-owner">${escapeHtml(repo.owner_name)}</span>
                  </span>
                </button>
                <button
                  class="repo-remove-button"
                  data-remove-repo-id="${repo.id}"
                  aria-label="${escapeHtml(repo.full_name || `${repo.owner_name}/${repo.repo_name}`)} をAgileLensから削除"
                  title="AgileLensから削除。GitHubリポジトリ本体は削除しません。"
                  ${state.repoDeleteBusyId === repo.id ? "disabled" : ""}
                >×</button>
              </div>
            `,
                )
                .join("")
        }
      </nav>
      <div class="sidebar-footer">
        <button class="add-repo-button" data-action="open-repo-dialog">＋ リポジトリ追加</button>
      </div>
    </aside>
  `;
}

function renderBoard() {
  const repoIssues = issues.filter((issue) => issue.repository_id === state.selectedRepoId);
  const columns = [
    { key: "Backlog", label: "未着手" },
    { key: "In Progress", label: "処理中" },
    { key: "Done", label: "完了" },
  ];

  return `
    <div class="toolbar">
      <div>
        <h3>アジャイルボード</h3>
        <p>GitHub Issueを3カラムで同期管理します。</p>
      </div>
      <div class="toolbar-actions">
        <button class="secondary-button" data-action="sync-progress" ${state.progressSyncing ? "disabled" : ""}>
          ${state.progressSyncing ? "同期中" : "GitHub進捗同期"}
        </button>
        <button class="secondary-button" data-action="generate-claude-tasks" ${state.claudeTaskGenerating ? "disabled" : ""}>
          ${state.claudeTaskGenerating ? "生成中" : "CLAUDE.mdから生成"}
        </button>
      </div>
    </div>
    ${state.issuesLoadError ? `<p class="form-error board-message">${escapeHtml(state.issuesLoadError)}</p>` : ""}
    ${state.progressSyncError ? `<p class="form-error board-message">${escapeHtml(state.progressSyncError)}</p>` : ""}
    ${state.claudeTaskError ? `<p class="form-error board-message">${escapeHtml(state.claudeTaskError)}</p>` : ""}
    ${renderProgressSyncMeta()}
    <div class="board">
      ${columns
        .map((column) => {
          const columnIssues = repoIssues.filter((issue) => issue.kanban_column === column.key);
          return `
            <section class="column" data-column="${column.key}" data-column-label="${column.label}">
              <div class="column-header">
                <div class="column-title-row">
                  <h4>${column.label}</h4>
                  ${
                    column.key === "Backlog"
                      ? '<button class="column-add-button" data-action="open-task-dialog" aria-label="タスク追加" title="タスク追加">+</button>'
                      : ""
                  }
                </div>
                <span class="count-pill">${columnIssues.length}</span>
              </div>
              <div class="card-list">
                ${
                  state.issuesLoading
                    ? '<div class="column-empty">タスクを読み込んでいます</div>'
                    : columnIssues.length > 0
                      ? columnIssues.map(renderIssueCard).join("")
                      : `<div class="column-empty">${column.key === "Backlog" ? "タスク未登録" : "該当タスクなし"}</div>`
                }
              </div>
            </section>
          `;
        })
        .join("")}
    </div>
    ${state.taskDialogOpen ? renderTaskDialog() : ""}
    ${state.pointDialogOpen ? renderPointDialog() : ""}
  `;
}

function renderProgressSyncMeta() {
  if (!state.progressSyncing && !state.lastProgressSyncedAt) return "";

  return `
    <div class="board-sync-meta">
      <span>${state.progressSyncing ? "GitHubのコミットとコードを確認しています" : "GitHub進捗同期済み"}</span>
      ${state.lastProgressSyncedAt ? `<time>${formatDateTime(state.lastProgressSyncedAt)}</time>` : ""}
    </div>
  `;
}

function renderTaskDialog() {
  return `
    <div class="modal-backdrop" data-action="close-task-dialog">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
        <div class="modal-header">
          <h3 id="task-dialog-title">タスク追加</h3>
          <button class="icon-button modal-close" data-action="close-task-dialog" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">
          <div class="task-form">
            <div class="field task-title-field">
              <label for="task-title">Issueタイトル</label>
              <input id="task-title" type="text" placeholder="例: EVM計算ロジックを実装する" data-task-field="title" />
            </div>
            <div class="field">
              <label for="task-assignee">担当者</label>
              <input id="task-assignee" type="text" value="AK" maxlength="3" data-task-field="assignee" />
            </div>
            <div class="field">
              <label for="task-point">Story Point</label>
              <select id="task-point" data-task-field="story_point">
                ${[1, 2, 3, 5, 8, 13].map((point) => `<option value="${point}">${point}</option>`).join("")}
              </select>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary-button" data-action="close-task-dialog">キャンセル</button>
          <button class="primary-button" data-action="create-task" ${state.taskSaveBusy ? "disabled" : ""}>
            ${state.taskSaveBusy ? "追加中" : "追加"}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderPointDialog() {
  const issue = issues.find((item) => item.id === state.selectedIssueId);
  if (!issue) return "";
  const description = issue.description || "詳細は未登録です。";

  return `
    <div class="modal-backdrop" data-action="close-point-dialog">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="point-dialog-title">
        <div class="modal-header">
          <h3 id="point-dialog-title">タスク詳細</h3>
          <button class="icon-button modal-close" data-action="close-point-dialog" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">
          <p class="dialog-task-title">${escapeHtml(issue.title)}</p>
          <div class="task-detail-block">
            <span>詳細</span>
            <p>${escapeHtml(description)}</p>
          </div>
          <div class="field">
            <label for="edit-story-point">Story Point</label>
            <select id="edit-story-point" data-point-field="story_point">
              ${[0, 1, 2, 3, 5, 8, 13]
                .map(
                  (point) =>
                    `<option value="${point}" ${issue.story_point === point ? "selected" : ""}>${point}</option>`,
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary-button" data-action="close-point-dialog">キャンセル</button>
          <button class="primary-button" data-action="save-point" ${state.issueSaveBusy ? "disabled" : ""}>
            ${state.issueSaveBusy ? "保存中" : "保存"}
          </button>
        </div>
      </section>
    </div>
  `;
}

function formatShortDate(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDateTime(dateText) {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function calculateDueDate(startDate, cycleDays) {
  const date = new Date(`${startDate}T00:00:00`);
  date.setDate(date.getDate() + cycleDays - 1);
  return date.toISOString().slice(0, 10);
}

function renderIssueCard(issue) {
  const assignee = issue.assignee || issue.assignee_username || "NA";
  const context = issue.task_context || (issue.source === "claude" ? "CLAUDE" : assignee);
  const contextClass = contextBadgeClass(context);

  return `
    <article class="issue-card" draggable="true" data-issue-id="${issue.id}">
      <p class="issue-title">${escapeHtml(issue.title)}</p>
      <div class="issue-meta">
        <span class="context-badge ${contextClass}" title="${escapeHtml(context)}">${escapeHtml(context)}</span>
        <span class="point-pill">sp:${issue.story_point}</span>
      </div>
    </article>
  `;
}

function contextBadgeClass(context) {
  if (/^1\b|画面|UI|ログイン|ボード|サイドバー|ヘッダー/.test(context)) {
    return "context-ui";
  }
  if (/^2\b|DB|テーブル|RLS/.test(context)) {
    return "context-db";
  }
  if (/EVM|PV|EV|AC/.test(context)) {
    return "context-evm";
  }
  if (/^3\b|同期|フロー|GitHub/.test(context)) {
    return "context-flow";
  }
  if (/^4\b|権限|ロール/.test(context)) {
    return "context-auth";
  }
  return "context-default";
}

function renderAnalytics() {
  const repo = currentRepo();
  const latestEvm = evmData[evmData.length - 1];
  const sv = latestEvm.ev - latestEvm.pv;
  const cv = latestEvm.ev - latestEvm.ac;
  const spi = latestEvm.pv === 0 ? 0 : latestEvm.ev / latestEvm.pv;
  const cpi = latestEvm.ac === 0 ? 0 : latestEvm.ev / latestEvm.ac;

  return `
    <div class="analytics-grid">
      <div class="toolbar">
        <div>
          <h3>EVMアナリティクス</h3>
          <p>プロジェクト全体のPV/EV/ACを可視化します。</p>
        </div>
      </div>
      <div class="analytics-top">
        <div class="analytics-settings-row">
          <section class="panel compact-panel">
            <div class="panel-header">
              <h3>本日の稼働時間入力</h3>
            </div>
            <div class="panel-body">
              <div class="form-row">
                <div class="field">
                  <label for="working-hours">稼働時間</label>
                  <input id="working-hours" type="number" min="0" step="0.25" value="4.5" />
                </div>
                <div class="unit-label">時間</div>
                <button class="primary-button" data-action="save-hours">登録</button>
              </div>
            </div>
          </section>
          <section class="panel compact-panel">
            <div class="panel-header">
              <h3>時給設定</h3>
            </div>
            <div class="panel-body">
              <div class="form-row wage-form-row">
                <div class="field">
                  <label for="hourly-wage">時給</label>
                  <input id="hourly-wage" type="number" min="0" step="100" value="${repo.hourly_wage}" data-repo-field="hourly_wage" />
                </div>
                <div class="unit-label">円</div>
                <button class="primary-button" data-action="save-hourly-wage">保存</button>
              </div>
            </div>
          </section>
        </div>
        <section class="panel">
          <div class="panel-header">
            <h3>サマリー</h3>
          </div>
          <div class="panel-body">
            <div class="summary-grid">
              <div class="metric">
                <span>SV</span>
                <strong class="${sv >= 0 ? "metric-good" : "metric-bad"}">${formatCurrency(sv)}</strong>
              </div>
              <div class="metric">
                <span>CV</span>
                <strong class="${cv >= 0 ? "metric-good" : "metric-bad"}">${formatCurrency(cv)}</strong>
              </div>
              <div class="metric">
                <span>SPI</span>
                <strong class="${spi >= 1 ? "metric-good" : "metric-bad"}">${spi.toFixed(2)}</strong>
              </div>
              <div class="metric">
                <span>CPI</span>
                <strong class="${cpi >= 1 ? "metric-good" : "metric-bad"}">${cpi.toFixed(2)}</strong>
              </div>
            </div>
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-header">
          <h3>EVM推移</h3>
          <span class="status-pill">PV / EV / AC</span>
        </div>
        <div class="panel-body">
          <div class="chart-wrap">
            ${renderChart()}
          </div>
          <div class="legend">
            <span class="legend-item"><span class="legend-color" style="background: var(--blue)"></span>PV 計画価値</span>
            <span class="legend-item"><span class="legend-color" style="background: var(--green)"></span>EV 獲得価値</span>
            <span class="legend-item"><span class="legend-color" style="background: var(--red)"></span>AC 実績コスト</span>
          </div>
        </div>
      </section>
    </div>
  `;
}

function formatCurrency(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}¥${Math.abs(value).toLocaleString()}`;
}

function renderChart() {
  const width = 760;
  const height = 340;
  const padding = { top: 24, right: 26, bottom: 44, left: 70 };
  const maxValue = Math.max(...evmData.flatMap((item) => [item.pv, item.ev, item.ac]));
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const xStep = innerWidth / (evmData.length - 1);

  function point(value, index) {
    const x = padding.left + xStep * index;
    const y = padding.top + innerHeight - (value / maxValue) * innerHeight;
    return `${x},${y}`;
  }

  function polyline(key) {
    return evmData.map((item, index) => point(item[key], index)).join(" ");
  }

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="EVM推移グラフ">
      ${[0, 1, 2, 3, 4]
        .map((tick) => {
          const y = padding.top + (innerHeight / 4) * tick;
          return `<line class="chart-grid" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" />`;
        })
        .join("")}
      <line class="chart-axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" />
      <line class="chart-axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" />
      <polyline class="line-pv" points="${polyline("pv")}" />
      <polyline class="line-ev" points="${polyline("ev")}" />
      <polyline class="line-ac" points="${polyline("ac")}" />
      ${evmData
        .map((item, index) => {
          const x = padding.left + xStep * index;
          return `<text x="${x}" y="${height - 16}" text-anchor="middle" fill="#607080" font-size="12">${item.day}</text>`;
        })
        .join("")}
      <text x="18" y="30" fill="#607080" font-size="12">金額</text>
    </svg>
  `;
}

function bindDashboardEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => routeTo(button.dataset.view));
  });

  document.querySelectorAll("[data-repo-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedRepoId = button.dataset.repoId;
      ensureDefaultSprint(state.selectedRepoId);
      const nextSprint = sprints.find((sprint) => sprint.repository_id === state.selectedRepoId);
      if (nextSprint) {
        state.selectedSprintId = nextSprint.id;
        state.selectedAnalyticsSprintId = nextSprint.id;
      }
      state.issuesLoading = true;
      state.issuesLoadError = null;
      state.progressSyncError = null;
      state.claudeTaskError = null;
      state.sidebarOpen = false;
      window.location.hash = `/projects/${state.selectedRepoId}/${state.view}`;
      render();
      await loadIssues(state.selectedRepoId);
      render();
    });
  });

  document.querySelectorAll(".issue-card").forEach((card) => {
    card.addEventListener("dragstart", () => {
      state.draggedIssueId = card.dataset.issueId;
    });
    card.addEventListener("click", () => {
      state.selectedIssueId = card.dataset.issueId;
      state.pointDialogOpen = true;
      render();
    });
  });

  document.querySelectorAll(".column").forEach((column) => {
    column.addEventListener("dragover", (event) => event.preventDefault());
    column.addEventListener("drop", async () => {
      const issue = issues.find((item) => item.id === state.draggedIssueId);
      if (!issue) return;
      const previousColumn = issue.kanban_column;
      const nextColumn = column.dataset.column;
      if (previousColumn === nextColumn) {
        state.draggedIssueId = null;
        return;
      }

      issue.kanban_column = nextColumn;
      state.draggedIssueId = null;
      render();

      try {
        const data = await updateIssue(issue.id, { kanban_column: nextColumn });
        mergeIssue(data.issue);
        render();
        showToast(`タスク位置を ${column.dataset.columnLabel} に保存しました`);
      } catch (error) {
        issue.kanban_column = previousColumn;
        render();
        showToast(error.message);
      }
    });
  });

  const logoutButton = document.querySelector("[data-action='logout']");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await logout();
    });
  }

  const actionMap = {
    "save-hours": "本日の稼働時間を登録し、ACスナップショットを更新しました",
  };

  Object.keys(actionMap).forEach((action) => {
    const button = document.querySelector(`[data-action='${action}']`);
    if (button) {
      button.addEventListener("click", () => showToast(actionMap[action]));
    }
  });

  const toggleSidebar = document.querySelector("[data-action='toggle-sidebar']");
  if (toggleSidebar) {
    toggleSidebar.addEventListener("click", () => {
      state.sidebarOpen = !state.sidebarOpen;
      render();
    });
  }

  const closeSidebar = document.querySelector("[data-action='close-sidebar']");
  if (closeSidebar) {
    closeSidebar.addEventListener("click", () => {
      state.sidebarOpen = false;
      render();
    });
  }

  document.querySelectorAll("[data-remove-repo-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await deleteRepositoryFromApp(button.dataset.removeRepoId);
    });
  });

  document.querySelectorAll("[data-action='open-repo-dialog']").forEach((button) => {
    button.addEventListener("click", async () => {
      state.repoDialogOpen = true;
      state.repoSaveError = null;
      state.githubRepoLoadError = null;
      state.githubRepoLoading = true;
      state.sidebarOpen = false;
      render();
      await loadGithubRepositories();
    });
  });

  document.querySelectorAll("[data-action='close-repo-dialog']").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.repoSaveBusy) return;
      state.repoDialogOpen = false;
      state.repoSaveError = null;
      render();
    });
  });

  const openTaskDialog = document.querySelector("[data-action='open-task-dialog']");
  if (openTaskDialog) {
    openTaskDialog.addEventListener("click", () => {
      state.taskDialogOpen = true;
      render();
    });
  }

  document.querySelectorAll("[data-action='close-task-dialog']").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      state.taskDialogOpen = false;
      render();
    });
  });

  document.querySelectorAll("[data-action='close-point-dialog']").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      state.pointDialogOpen = false;
      state.selectedIssueId = null;
      render();
    });
  });

  const modal = document.querySelector(".modal");
  if (modal) {
    modal.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  const createRepoButton = document.querySelector("[data-action='create-repo']");
  if (createRepoButton) {
    createRepoButton.addEventListener("click", async () => {
      await createRepository();
    });
  }

  const generateClaudeTasksButton = document.querySelector("[data-action='generate-claude-tasks']");
  if (generateClaudeTasksButton) {
    generateClaudeTasksButton.addEventListener("click", async () => {
      await generateClaudeTasks();
    });
  }

  const syncProgressButton = document.querySelector("[data-action='sync-progress']");
  if (syncProgressButton) {
    syncProgressButton.addEventListener("click", async () => {
      await syncProgress();
    });
  }

  const createTaskButton = document.querySelector("[data-action='create-task']");
  if (createTaskButton) {
    createTaskButton.addEventListener("click", async () => {
      await createManualTask();
    });
  }

  const savePointButton = document.querySelector("[data-action='save-point']");
  if (savePointButton) {
    savePointButton.addEventListener("click", async () => {
      const issue = issues.find((item) => item.id === state.selectedIssueId);
      if (!issue) return;

      const storyPoint = Number(document.querySelector("[data-point-field='story_point']").value);
      const previousPoint = issue.story_point;
      issue.story_point = storyPoint;
      state.issueSaveBusy = true;
      render();

      try {
        const data = await updateIssue(issue.id, { story_point: storyPoint });
        mergeIssue(data.issue);
        state.issueSaveBusy = false;
        state.pointDialogOpen = false;
        state.selectedIssueId = null;
        render();
        showToast("Story PointをDBに保存しました");
      } catch (error) {
        issue.story_point = previousPoint;
        state.issueSaveBusy = false;
        render();
        showToast(error.message);
      }
    });
  }

  const saveHourlyWageButton = document.querySelector("[data-action='save-hourly-wage']");
  if (saveHourlyWageButton) {
    saveHourlyWageButton.addEventListener("click", () => {
      const repo = currentRepo();
      repo.hourly_wage = Number(document.querySelector("[data-repo-field='hourly_wage']").value) || 0;
      render();
      showToast("時給設定を保存しました");
    });
  }

}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 2600);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseRoute() {
  const hash = window.location.hash || "";
  const projectMatch = hash.match(/^#\/projects\/([^/]+)\/(board|analytics)/);
  return {
    isLogin: hash.startsWith("#/login"),
    repoId: projectMatch ? decodeURIComponent(projectMatch[1]) : null,
    view: projectMatch ? projectMatch[2] : hash.includes("analytics") ? "analytics" : "board",
  };
}

function loginErrorMessage() {
  const [, query = ""] = (window.location.hash || "").split("?");
  const error = new URLSearchParams(query).get("auth_error");
  const messages = {
    missing_supabase_config: "Supabase URLとAnon Keyを設定してください。",
    invalid_auth_callback: "OAuthの検証に失敗しました。もう一度ログインしてください。",
    exchange_failed: "GitHubログインの完了処理に失敗しました。",
    access_denied: "GitHubログインがキャンセルされました。",
  };

  return error ? messages[error] || "ログインに失敗しました。もう一度試してください。" : "";
}

async function loadRepositories() {
  state.repoLoading = true;
  state.repoLoadError = null;

  try {
    const data = await apiRequest("/api/repositories");
    repositories = data.repositories || [];
    selectRepositoryFromRoute();
  } catch (error) {
    repositories = [];
    state.selectedRepoId = null;
    state.repoLoadError = error.message;
  } finally {
    state.repoLoading = false;
  }
}

async function loadIssues(repositoryId = state.selectedRepoId) {
  if (!repositoryId) {
    issues = [];
    return;
  }

  state.issuesLoading = true;
  state.issuesLoadError = null;
  state.progressSyncError = null;
  state.progressSyncing = true;

  try {
    let data = null;

    try {
      data = await syncRepositoryProgress(repositoryId);
      state.lastProgressSyncedAt = data.synced_at || new Date().toISOString();
    } catch (syncError) {
      state.progressSyncError = syncError.message;
      data = await apiRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/issues`);
    }

    issues = data.issues || [];
  } catch (error) {
    issues = [];
    state.issuesLoadError = error.message;
  } finally {
    state.progressSyncing = false;
    state.issuesLoading = false;
  }
}

async function loadGithubRepositories() {
  state.githubRepoLoading = true;
  state.githubRepoLoadError = null;
  render();

  try {
    const data = await apiRequest("/api/github/repositories");
    state.availableGithubRepos = data.repositories || [];
    const firstSelectable = state.availableGithubRepos.find((repo) => !repo.registered);
    state.repoForm.github_repo_id = firstSelectable ? firstSelectable.id : "";
  } catch (error) {
    state.availableGithubRepos = [];
    state.repoForm.github_repo_id = "";
    state.githubRepoLoadError = error.message;
  } finally {
    state.githubRepoLoading = false;
    render();
  }
}

function selectRepositoryFromRoute() {
  const route = parseRoute();
  const routedRepo = route.repoId
    ? repositories.find((repo) => repo.id === route.repoId)
    : null;
  const selectedRepo = repositories.find((repo) => repo.id === state.selectedRepoId);
  const nextRepo = routedRepo || selectedRepo || repositories[0] || null;

  state.selectedRepoId = nextRepo ? nextRepo.id : null;
  if (nextRepo) {
    ensureDefaultSprint(nextRepo.id);
    const nextSprint = sprints.find((sprint) => sprint.repository_id === nextRepo.id);
    if (nextSprint) {
      state.selectedSprintId = nextSprint.id;
      state.selectedAnalyticsSprintId = nextSprint.id;
    }
  }
}

async function createRepository() {
  const selectedRepoId = document.querySelector("[data-repo-field='github_repo_id']")?.value || "";

  state.repoForm = {
    github_repo_id: selectedRepoId,
  };

  if (!selectedRepoId) {
    state.repoSaveError = "追加するGitHubリポジトリを選択してください。";
    render();
    return;
  }

  state.repoSaveBusy = true;
  state.repoSaveError = null;
  render();

  try {
    const data = await apiRequest("/api/repositories", {
      method: "POST",
      body: {
        github_repo_id: selectedRepoId,
      },
    });
    const repository = data.repository;
    upsertRepository(repository);
    state.selectedRepoId = repository.id;
    ensureDefaultSprint(repository.id);
    const sprint = sprints.find((item) => item.repository_id === repository.id);
    if (sprint) {
      state.selectedSprintId = sprint.id;
      state.selectedAnalyticsSprintId = sprint.id;
    }
    state.repoDialogOpen = false;
    state.repoSaveBusy = false;
    state.repoSaveError = null;
    state.repoForm = {
      github_repo_id: "",
    };
    state.availableGithubRepos = state.availableGithubRepos.map((repo) =>
      repo.id === String(repository.github_repo_id) ? { ...repo, registered: true } : repo,
    );
    issues = [];
    await loadIssues(repository.id);
    window.location.hash = `/projects/${repository.id}/board`;
    render();
    showToast(`${repository.owner_name}/${repository.repo_name} を追加しました`);
  } catch (error) {
    state.repoSaveBusy = false;
    state.repoSaveError = error.message;
    render();
  }
}

async function deleteRepositoryFromApp(repositoryId) {
  const repository = repositories.find((item) => item.id === repositoryId);
  if (!repository || state.repoDeleteBusyId) return;

  const fullName = repository.full_name || `${repository.owner_name}/${repository.repo_name}`;
  const confirmed = window.confirm(
    `${fullName} をAgileLensから削除します。\nGitHubリポジトリ本体は削除されません。`,
  );
  if (!confirmed) return;

  state.repoDeleteBusyId = repositoryId;
  render();

  try {
    await apiRequest(`/api/repositories/${encodeURIComponent(repositoryId)}`, {
      method: "DELETE",
    });

    repositories = repositories.filter((item) => item.id !== repositoryId);
    issues = issues.filter((issue) => issue.repository_id !== repositoryId);
    state.availableGithubRepos = state.availableGithubRepos.map((repo) =>
      String(repo.id) === String(repository.github_repo_id) ? { ...repo, registered: false } : repo,
    );

    if (state.selectedRepoId === repositoryId) {
      const nextRepo = repositories[0] || null;
      state.selectedRepoId = nextRepo ? nextRepo.id : null;
      state.selectedIssueId = null;
      state.pointDialogOpen = false;
      state.sidebarOpen = false;

      if (nextRepo) {
        ensureDefaultSprint(nextRepo.id);
        state.repoDeleteBusyId = null;
        window.location.hash = `/projects/${nextRepo.id}/${state.view}`;
        await loadIssues(nextRepo.id);
      } else {
        state.repoDeleteBusyId = null;
        window.location.hash = "/projects";
      }
    } else {
      state.repoDeleteBusyId = null;
    }

    render();
    showToast(`${fullName} をAgileLensから削除しました`);
  } catch (error) {
    state.repoDeleteBusyId = null;
    render();
    showToast(error.message);
  }
}

async function createManualTask() {
  if (!state.selectedRepoId) return;

  const title = document.querySelector("[data-task-field='title']")?.value.trim() || "";
  const assignee = document.querySelector("[data-task-field='assignee']")?.value.trim() || "NA";
  const storyPoint = Number(document.querySelector("[data-task-field='story_point']")?.value || 1);

  if (!title) {
    showToast("Issueタイトルを入力してください");
    return;
  }

  state.taskSaveBusy = true;
  render();

  try {
    const data = await apiRequest(
      `/api/repositories/${encodeURIComponent(state.selectedRepoId)}/issues`,
      {
        method: "POST",
        body: {
          title,
          description: title,
          assignee_username: assignee.slice(0, 32),
          story_point: storyPoint,
          kanban_column: "Backlog",
        },
      },
    );

    if (data.issue) {
      issues.unshift(data.issue);
    }
    state.taskSaveBusy = false;
    state.taskDialogOpen = false;
    render();
    showToast("タスクをDBに保存しました");
  } catch (error) {
    state.taskSaveBusy = false;
    render();
    showToast(error.message);
  }
}

async function generateClaudeTasks() {
  if (!state.selectedRepoId) return;

  state.claudeTaskGenerating = true;
  state.claudeTaskError = null;
  render();

  try {
    const data = await apiRequest(
      `/api/repositories/${encodeURIComponent(state.selectedRepoId)}/generate-claude-tasks`,
      {
        method: "POST",
      },
    );
    issues = data.issues || [];
    state.claudeTaskGenerating = false;
    render();

    if (data.created_count > 0) {
      showToast(`CLAUDE.mdから${data.created_count}件のタスクを生成しました`);
    } else {
      showToast("CLAUDE.md由来のタスクはすでに登録済みです");
    }
  } catch (error) {
    state.claudeTaskGenerating = false;
    state.claudeTaskError = error.message;
    render();
  }
}

async function syncProgress() {
  if (!state.selectedRepoId) return;

  state.progressSyncing = true;
  state.progressSyncError = null;
  render();

  try {
    const data = await syncRepositoryProgress(state.selectedRepoId);
    issues = data.issues || [];
    state.lastProgressSyncedAt = data.synced_at || new Date().toISOString();
    state.progressSyncing = false;
    render();

    if (data.updated_count > 0) {
      showToast(`${data.updated_count}件の進捗をGitHubから同期しました`);
    } else if (data.matched_count > 0) {
      showToast("GitHubの進捗はすでに反映済みです");
    } else {
      showToast("一致するGitHubコミットはまだありません");
    }
  } catch (error) {
    state.progressSyncing = false;
    state.progressSyncError = error.message;
    render();
  }
}

async function syncRepositoryProgress(repositoryId) {
  return apiRequest(`/api/repositories/${encodeURIComponent(repositoryId)}/sync-progress`, {
    method: "POST",
  });
}

async function updateIssue(issueId, body) {
  return apiRequest(
    `/api/repositories/${encodeURIComponent(state.selectedRepoId)}/issues/${encodeURIComponent(issueId)}`,
    {
      method: "PATCH",
      body,
    },
  );
}

function mergeIssue(updatedIssue) {
  if (!updatedIssue) return;

  const index = issues.findIndex((issue) => issue.id === updatedIssue.id);
  if (index === -1) {
    issues.unshift(updatedIssue);
    return;
  }

  const existingIssue = issues[index];
  issues[index] = {
    ...existingIssue,
    ...updatedIssue,
    title: updatedIssue.title || existingIssue.title,
    description: updatedIssue.description || existingIssue.description,
    task_context: updatedIssue.task_context || existingIssue.task_context,
  };
}

function upsertRepository(repository) {
  const existingIndex = repositories.findIndex((item) => item.id === repository.id);
  if (existingIndex >= 0) {
    repositories[existingIndex] = repository;
    return;
  }
  repositories.push(repository);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || "APIリクエストに失敗しました。");
  }

  return data;
}

async function initAuth() {
  const route = parseRoute();
  state.view = route.view;

  try {
    const response = await fetch("/api/auth/me", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Failed to load auth session");

    const data = await response.json();
    state.authConfigured = data.configured !== false;
    state.loggedIn = Boolean(data.authenticated);
    state.user = data.user || null;
    state.authError = state.authConfigured
      ? null
      : "Supabase URLとAnon Keyを.envに設定してください。";
    if (state.loggedIn) {
      await loadRepositories();
      await loadIssues();
    }
  } catch (error) {
    state.authConfigured = true;
    state.loggedIn = false;
    state.user = null;
    state.authError = "認証サーバーに接続できませんでした。";
  } finally {
    state.authChecking = false;
    state.loginBusy = false;

    const latestRoute = parseRoute();
    if (!state.loggedIn && !latestRoute.isLogin) {
      window.location.hash = "/login";
      return;
    }

    if (state.loggedIn && latestRoute.isLogin && state.selectedRepoId) {
      window.location.hash = `/projects/${state.selectedRepoId}/${state.view}`;
      return;
    }

    if (
      state.loggedIn &&
      state.selectedRepoId &&
      (!latestRoute.repoId || latestRoute.repoId !== state.selectedRepoId)
    ) {
      window.location.hash = `/projects/${state.selectedRepoId}/${state.view}`;
      return;
    }

    render();
  }
}

async function logout() {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => null);

  state.loggedIn = false;
  state.user = null;
  state.authError = null;
  state.loginBusy = false;
  window.location.hash = "/login";
  render();
}

window.addEventListener("hashchange", () => {
  const route = parseRoute();
  state.view = route.view;
  if (!state.authChecking && !state.loggedIn && !route.isLogin) {
    window.location.hash = "/login";
    return;
  }
  if (state.loggedIn && route.repoId) {
    const repo = repositories.find((item) => item.id === route.repoId);
    if (repo && state.selectedRepoId !== repo.id) {
      state.selectedRepoId = repo.id;
      ensureDefaultSprint(repo.id);
      loadIssues(repo.id).then(() => render());
    }
  }
  render();
});

render();
initAuth();

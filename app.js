const initialRoute = parseRoute();

const state = {
  authChecking: true,
  authConfigured: true,
  authError: null,
  loggedIn: false,
  user: null,
  view: initialRoute.view,
  selectedRepoId: "repo-1",
  selectedSprintId: "sprint-1",
  selectedAnalyticsSprintId: "sprint-1",
  draggedIssueId: null,
  selectedIssueId: null,
  sidebarOpen: false,
  sprintDialogOpen: false,
  taskDialogOpen: false,
  pointDialogOpen: false,
};

const repositories = [
  {
    id: "repo-1",
    repo_name: "AgileLens",
    owner_name: "product-lab",
    hourly_wage: 5000,
    point_unit_price: 12000,
  },
  {
    id: "repo-2",
    repo_name: "DesignOps",
    owner_name: "studio-team",
    hourly_wage: 4500,
    point_unit_price: 10000,
  },
  {
    id: "repo-3",
    repo_name: "DocsHub",
    owner_name: "content-team",
    hourly_wage: 4200,
    point_unit_price: 9000,
  },
];

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

const issues = [
  {
    id: "issue-1",
    repository_id: "repo-1",
    sprint_id: "sprint-1",
    title: "GitHub OAuthログイン画面を実装する",
    assignee: "AK",
    story_point: 3,
    kanban_column: "Backlog",
  },
  {
    id: "issue-2",
    repository_id: "repo-1",
    sprint_id: "sprint-1",
    title: "リポジトリ追加時にCLAUDE.mdを読み込むUIを作る",
    assignee: "MN",
    story_point: 5,
    kanban_column: "Backlog",
  },
  {
    id: "issue-3",
    repository_id: "repo-1",
    sprint_id: "sprint-1",
    title: "Issueカードのドラッグ＆ドロップ同期を設計する",
    assignee: "ST",
    story_point: 8,
    kanban_column: "In Progress",
  },
  {
    id: "issue-4",
    repository_id: "repo-1",
    sprint_id: "sprint-2",
    title: "EVM日次スナップショットの集計表示を確認する",
    assignee: "YK",
    story_point: 3,
    kanban_column: "In Progress",
  },
  {
    id: "issue-5",
    repository_id: "repo-1",
    sprint_id: "sprint-1",
    title: "MVP仕様レビューを完了する",
    assignee: "AK",
    story_point: 2,
    kanban_column: "Done",
  },
];

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
  return repositories.find((repo) => repo.id === state.selectedRepoId);
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

function routeTo(view) {
  state.view = view;
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
              <h2>${repo.repo_name}</h2>
              <span>${repo.owner_name}/${repo.repo_name}</span>
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
          ${state.view === "analytics" ? renderAnalytics() : renderBoard()}
        </section>
      </main>
    </div>
    <div id="toast" class="toast hidden"></div>
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
        ${repositories
          .map(
            (repo) => `
              <button class="repo-button ${repo.id === state.selectedRepoId ? "active" : ""}" data-repo-id="${repo.id}">
                <span class="repo-icon">${repo.repo_name.slice(0, 2).toUpperCase()}</span>
                <span>
                  <span class="repo-name">${repo.repo_name}</span>
                  <span class="repo-owner">${repo.owner_name}</span>
                </span>
              </button>
            `,
          )
          .join("")}
      </nav>
      <div class="sidebar-footer">
        <button class="add-repo-button" data-action="add-repo">＋ リポジトリ追加</button>
      </div>
    </aside>
  `;
}

function renderBoard() {
  const sprint = currentSprint();
  const repoIssues = issues.filter(
    (issue) =>
      issue.repository_id === state.selectedRepoId && issue.sprint_id === state.selectedSprintId,
  );
  const columns = [
    { key: "Backlog", label: "未着手" },
    { key: "In Progress", label: "処理中" },
    { key: "Done", label: "完了" },
  ];

  return `
    <div class="toolbar">
      <div>
        <h3>アジャイルボード</h3>
        <p>${sprint.title} のGitHub Issueを3カラムで同期管理します。</p>
      </div>
      <div class="toolbar-actions">
        ${renderSprintSelect("board-sprint")}
        <button class="icon-button sprint-settings-button" data-action="open-sprint-dialog" aria-label="スプリント設定" title="スプリント設定">⚙</button>
      </div>
    </div>
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
                ${columnIssues.map(renderIssueCard).join("")}
              </div>
            </section>
          `;
        })
        .join("")}
    </div>
    ${state.sprintDialogOpen ? renderSprintDialog() : ""}
    ${state.taskDialogOpen ? renderTaskDialog() : ""}
    ${state.pointDialogOpen ? renderPointDialog() : ""}
  `;
}

function renderSprintDialog() {
  const sprint = currentSprint();
  return `
    <div class="modal-backdrop" data-action="close-sprint-dialog">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="sprint-dialog-title">
        <div class="modal-header">
          <h3 id="sprint-dialog-title">スプリント設定</h3>
          <button class="icon-button modal-close" data-action="close-sprint-dialog" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">
          <div class="sprint-form">
            <div class="field">
              <label for="sprint-start">開始日</label>
              <input id="sprint-start" type="date" value="${sprint.start_date}" data-sprint-field="start_date" />
            </div>
            <div class="field">
              <label for="sprint-cycle">周期</label>
              <select id="sprint-cycle" data-sprint-field="cycle_days">
                ${[7, 10, 14, 21, 28]
                  .map(
                    (days) =>
                      `<option value="${days}" ${sprint.cycle_days === days ? "selected" : ""}>${days}日</option>`,
                  )
                  .join("")}
              </select>
            </div>
            <div class="field">
              <label for="sprint-due">終了日</label>
              <input id="sprint-due" type="date" value="${sprint.due_on}" readonly />
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary-button" data-action="close-sprint-dialog">キャンセル</button>
          <button class="primary-button" data-action="save-sprint-settings">保存</button>
        </div>
      </section>
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
          <button class="primary-button" data-action="create-task">追加</button>
        </div>
      </section>
    </div>
  `;
}

function renderPointDialog() {
  const issue = issues.find((item) => item.id === state.selectedIssueId);
  if (!issue) return "";

  return `
    <div class="modal-backdrop" data-action="close-point-dialog">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="point-dialog-title">
        <div class="modal-header">
          <h3 id="point-dialog-title">Story Point設定</h3>
          <button class="icon-button modal-close" data-action="close-point-dialog" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">
          <p class="dialog-task-title">${issue.title}</p>
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
          <button class="primary-button" data-action="save-point">保存</button>
        </div>
      </section>
    </div>
  `;
}

function renderSprintSelect(id, options = {}) {
  const selectedValue = options.analytics
    ? state.selectedAnalyticsSprintId
    : state.selectedSprintId;

  return `
    <div class="field sprint-select-field">
      <label for="${id}">スプリント</label>
      <select id="${id}" data-action="${options.analytics ? "select-analytics-sprint" : "select-sprint"}">
        ${repoSprints()
          .map(
            (sprint) =>
              `<option value="${sprint.id}" ${sprint.id === selectedValue ? "selected" : ""}>${formatSprintOption(sprint)}</option>`,
          )
          .join("")}
        ${options.includeOverall ? `<option value="all" ${selectedValue === "all" ? "selected" : ""}>全体のEVM</option>` : ""}
      </select>
    </div>
  `;
}

function formatSprintOption(sprint) {
  return `${formatSprintLabel(sprint.title)}: ${formatShortDate(sprint.start_date)}~${formatShortDate(sprint.due_on)}`;
}

function formatSprintLabel(title) {
  return title.split(":")[0].trim();
}

function formatShortDate(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function renderIssueCard(issue) {
  return `
    <article class="issue-card" draggable="true" data-issue-id="${issue.id}">
      <p class="issue-title">${issue.title}</p>
      <div class="issue-meta">
        <span class="avatar" title="担当者">${issue.assignee}</span>
        <span class="point-pill">sp:${issue.story_point}</span>
      </div>
    </article>
  `;
}

function renderAnalytics() {
  const repo = currentRepo();
  const analyticsSprint =
    state.selectedAnalyticsSprintId === "all"
      ? null
      : repoSprints().find((sprint) => sprint.id === state.selectedAnalyticsSprintId);
  const analyticsScopeLabel = analyticsSprint ? formatSprintOption(analyticsSprint) : "全体のEVM";
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
          <p>${analyticsScopeLabel} のPV/EV/ACを可視化します。</p>
        </div>
        ${renderSprintSelect("analytics-sprint", { analytics: true, includeOverall: true })}
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
    button.addEventListener("click", () => {
      state.selectedRepoId = button.dataset.repoId;
      const nextSprint = sprints.find((sprint) => sprint.repository_id === state.selectedRepoId);
      if (nextSprint) {
        state.selectedSprintId = nextSprint.id;
        state.selectedAnalyticsSprintId = nextSprint.id;
      }
      state.sidebarOpen = false;
      window.location.hash = `/projects/${state.selectedRepoId}/${state.view}`;
      render();
    });
  });

  document.querySelectorAll("[data-action='select-sprint']").forEach((select) => {
    select.addEventListener("change", () => {
      state.selectedSprintId = select.value;
      state.sprintDialogOpen = false;
      render();
    });
  });

  document.querySelectorAll("[data-action='select-analytics-sprint']").forEach((select) => {
    select.addEventListener("change", () => {
      state.selectedAnalyticsSprintId = select.value;
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
    column.addEventListener("drop", () => {
      const issue = issues.find((item) => item.id === state.draggedIssueId);
      if (!issue) return;
      issue.kanban_column = column.dataset.column;
      showToast(`GitHubラベルを ${column.dataset.columnLabel} に同期しました`);
      state.draggedIssueId = null;
      render();
    });
  });

  const logoutButton = document.querySelector("[data-action='logout']");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await logout();
    });
  }

  const actionMap = {
    "add-repo": "リポジトリ追加フロー: CLAUDE.md解析とIssue自動生成を開始します",
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

  const openSprintDialog = document.querySelector("[data-action='open-sprint-dialog']");
  if (openSprintDialog) {
    openSprintDialog.addEventListener("click", () => {
      state.sprintDialogOpen = true;
      render();
    });
  }

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

  document.querySelectorAll("[data-action='close-sprint-dialog']").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      state.sprintDialogOpen = false;
      render();
    });
  });

  const modal = document.querySelector(".modal");
  if (modal) {
    modal.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  const createTaskButton = document.querySelector("[data-action='create-task']");
  if (createTaskButton) {
    createTaskButton.addEventListener("click", () => {
      const title = document.querySelector("[data-task-field='title']").value.trim();
      const assignee = document.querySelector("[data-task-field='assignee']").value.trim() || "NA";
      const storyPoint = Number(document.querySelector("[data-task-field='story_point']").value);

      if (!title) {
        showToast("Issueタイトルを入力してください");
        return;
      }

      issues.unshift({
        id: `issue-${Date.now()}`,
        repository_id: state.selectedRepoId,
        sprint_id: state.selectedSprintId,
        title,
        assignee: assignee.slice(0, 3).toUpperCase(),
        story_point: storyPoint,
        kanban_column: "Backlog",
      });
      state.taskDialogOpen = false;
      render();
      showToast("タスクを未着手に追加しました");
    });
  }

  const savePointButton = document.querySelector("[data-action='save-point']");
  if (savePointButton) {
    savePointButton.addEventListener("click", () => {
      const issue = issues.find((item) => item.id === state.selectedIssueId);
      if (!issue) return;

      issue.story_point = Number(document.querySelector("[data-point-field='story_point']").value);
      state.pointDialogOpen = false;
      state.selectedIssueId = null;
      render();
      showToast("Story Pointを更新しました");
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

  const sprintStart = document.querySelector("[data-sprint-field='start_date']");
  const sprintCycle = document.querySelector("[data-sprint-field='cycle_days']");
  const sprintSettingsButton = document.querySelector("[data-action='save-sprint-settings']");
  if (sprintStart && sprintCycle && sprintSettingsButton) {
    sprintSettingsButton.addEventListener("click", () => {
      const sprint = currentSprint();
      sprint.start_date = sprintStart.value;
      sprint.cycle_days = Number(sprintCycle.value);
      sprint.due_on = calculateDueDate(sprint.start_date, sprint.cycle_days);
      state.sprintDialogOpen = false;
      render();
      showToast("スプリント周期を保存し、終了日を再計算しました");
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

function calculateDueDate(startDate, cycleDays) {
  const date = new Date(`${startDate}T00:00:00`);
  date.setDate(date.getDate() + cycleDays - 1);
  return date.toISOString().slice(0, 10);
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
  return {
    isLogin: hash.startsWith("#/login"),
    view: hash.includes("analytics") ? "analytics" : "board",
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

    if (state.loggedIn && latestRoute.isLogin) {
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
  render();
});

render();
initAuth();

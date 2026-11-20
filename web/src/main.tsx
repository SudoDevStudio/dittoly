import { BuildPanel } from './BuildPanel';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Logo } from './Logo';
import { api, ApiError, authConfig, logout, type AuthConfig, type Me } from './api';
import { Link, match, usePath } from './router';
import { ErrorBoundary } from './components';
import { Home } from './pages/Home';
import { Flows, FlowDetail } from './pages/Flows';
import { RunPage, Runs } from './pages/Runs';
import { Delegations, DelegationDetail } from './pages/Delegations';
import { ModuleReview, Modules } from './pages/Modules';
import { Marketplace } from './pages/Marketplace';
import { Credentials } from './pages/Credentials';
import { Admin } from './pages/Admin';
import { MeContext } from './context';
import { Avatar, Icon } from './ui';
import { CommandSearch } from './search';
import { RunFlow, RunHub } from './pages/RunHub';
import { BrowserPage } from './pages/BrowserPage';
import { Agents } from './pages/Agents';
import { Connect } from './pages/Connect';
import { ReversalPage } from './Undo';
import { Toasts } from './toast';
import { TeamProvider, TeamSwitcher } from './teams';
import { AiModelChip } from './AiModelChip';
import { TeamsPage } from './pages/Teams';
import { PlanPage, Plans } from './pages/Plans';
import { MobileApp } from './Mobile';
import { InsightsPage } from './pages/Insights';
import { AppExport } from './pages/AppExport';
import { TeamAppPage, TeamApps } from './pages/TeamApps';
import { ChangePage, ChangesPage } from './Changes';
import { ModelComparisonPage } from './ModelComparison';
import { AiInventoryPage } from './AiInventory';
import { ModelChangesPage } from './pages/ModelChanges';
import { Builds } from './pages/Builds';
import { ModuleByRef } from './ModuleLink';
import { AutoStopsPage } from './AutoStops';
import { Create } from './pages/Create';
import './styles.css';


const ROUTES: [string, (p: Record<string, string>) => React.ReactNode][] = [
  ['/', () => <Home />],
  ['/create', () => <Create />],
  ['/building', () => <Builds />],
  ['/flows', () => <Flows key="flows" />],
  ['/super-flows', () => <Flows key="super-flows" superOnly />],
  ['/flows/:id', (p) => <FlowDetail id={p.id!} />],
  ['/run', () => <RunHub />],
  ['/run/:versionId', (p) => <RunFlow versionId={p.versionId!} />],
  ['/runs', () => <Runs />],
  ['/runs/:id', (p) => <RunPage id={p.id!} />],
  ['/browser', () => <BrowserPage />],
  ['/browser/:id', (p) => <BrowserPage id={p.id!} />],
  ['/delegations', () => <Delegations />],
  ['/delegations/:id', (p) => <DelegationDetail id={p.id!} />],
  ['/insights', () => <InsightsPage />],
  ['/model-changes', () => <ModelChangesPage />],
  ['/auto-stops', () => <AutoStopsPage />],
  ['/plans', () => <Plans />],
  ['/plans/:id', (p) => <PlanPage id={p.id!} />],
  ['/modules', () => <Modules />],
  ['/modules/:id', (p) => <ModuleReview id={p.id!} />],
  ['/module/:ref', (p) => <ModuleByRef refText={decodeURIComponent(p.ref!)} />],
  ['/marketplace', () => <Marketplace />],
  ['/team-apps', () => <TeamApps />],
  ['/team-apps/:id', (p) => <TeamAppPage id={p.id!} />],
  ['/apps', () => <AppExport />],
  ['/credentials', () => <Credentials />],
  ['/agents', () => <Agents />],
  ['/connect/:id', (p) => <Connect id={p.id!} />],
  ['/reversals/:id', (p) => <ReversalPage id={p.id!} />],
  ['/teams', () => <TeamsPage />],
  ['/changes', () => <ChangesPage />],
  ['/changes/:id', (p) => <ChangePage id={p.id!} />],
  ['/ai-inventory', () => <AiInventoryPage />],
  ['/model-comparison', () => <ModelComparisonPage />],
  ['/admin', () => <Admin />],
];

/**
 * The sidebar: Home, four groups people can fold, and personal/admin entries at the bottom. A member sees only what
 * they can use; each entry says in a hint what it is for. Labels here are short; pages keep their own titles.
 */
interface NavItem { to: string; label: string; icon: string; hint: string; show?: (me: Me) => boolean }
const approverOrAdmin = (me: Me) => me.role === 'admin' || me.role === 'approver';
const adminOnly = (me: Me) => me.role === 'admin';
const NAV_HOME: NavItem = { to: '/', label: 'Home', icon: 'home', hint: 'What waits for you, and recent activity' };
const NAV_CREATE: NavItem = { to: '/create', label: 'Create', icon: 'plus', hint: 'Automate a task or connect an app: say what you need' };
/** What most people use every day is always shown; the rest is one click away under More, folded at first. */
const NAV_GROUPS: { id: string; label: string; folded?: boolean; items: NavItem[] }[] = [
  { id: 'build', label: 'Build', items: [
    { to: '/flows', label: 'Flows', icon: 'flow', hint: 'Automations you describe, approve and run' },
    { to: '/modules', label: 'Modules', icon: 'layers', hint: 'Connections to your apps, reviewed before use' },
    { to: '/team-apps', label: 'Apps', icon: 'grid', hint: "Pages over your team's Flows, shared with the team" },
    { to: '/building', label: 'Building', icon: 'sparkles', hint: 'What the AI is building now: modules, Flows and Super Flows' },
  ] },
  { id: 'run', label: 'Run', items: [
    { to: '/run', label: 'Run a Flow', icon: 'arrow', hint: 'Pick an approved Flow and start it' },
    { to: '/runs', label: 'Runs', icon: 'bolt', hint: 'What ran, what is running and what waits' },
  ] },
  { id: 'more', label: 'More', folded: true, items: [
    { to: '/super-flows', label: 'Super Flows', icon: 'superflow', hint: 'Run several approved Flows in stages' },
    { to: '/plans', label: 'Plans from PDF', icon: 'file', hint: 'Upload a plan; the AI drafts its modules and Flows' },
    { to: '/delegations', label: 'Delegations', icon: 'users', hint: 'Steps teammates hand to you, and yours to them' },
    { to: '/insights', label: 'Insights', icon: 'chart', hint: 'Failures, waiting times and time saved' },
    { to: '/marketplace', label: 'Marketplace', icon: 'market', hint: 'Modules and Flows shared across the organization' },
    { to: '/agents', label: 'AI Agents', icon: 'bot', hint: 'Let AI assistants use approved Flows' },
    { to: '/apps', label: 'Export an app', icon: 'download', hint: 'Package Flows as an app that runs on its own', show: approverOrAdmin },
  ] },
  { id: 'oversight', label: 'Oversight', folded: true, items: [
    { to: '/changes', label: 'Changes', icon: 'refresh', hint: 'Fixes drafted for modules whose app changed', show: approverOrAdmin },
    { to: '/model-changes', label: 'Model changes', icon: 'cpu', hint: 'Check Flows before switching AI models', show: approverOrAdmin },
    { to: '/auto-stops', label: 'Automatic stops', icon: 'stop', hint: 'Flows stopped when a control failed', show: approverOrAdmin },
    { to: '/model-comparison', label: 'Model comparison', icon: 'chart', hint: 'Which AI writes the better work here', show: approverOrAdmin },
    { to: '/ai-inventory', label: 'AI inventory', icon: 'eye', hint: 'Everywhere AI is used, and by whom', show: adminOnly },
  ] },
];
const NAV_BOTTOM: NavItem[] = [
  { to: '/teams', label: 'Teams', icon: 'users', hint: 'Teams, their members and shared keys' },
  { to: '/credentials', label: 'My credentials', icon: 'key', hint: 'Your own keys, kept in your vault' },
  { to: '/admin', label: 'Members & Access', icon: 'shield', hint: 'People, roles and organization settings', show: adminOnly },
];
const NAV_ALL = [NAV_HOME, NAV_CREATE, ...NAV_GROUPS.flatMap((g) => g.items), ...NAV_BOTTOM];
const GROUPS_KEY = 'dittoly-nav-groups';

function SignIn({ cfg }: { cfg: AuthConfig | null }) {
  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <main className="signin">
      <span className="brand-mark"><Logo size={30}/></span>
      <h1>Dittoly</h1>
      <span className="eyebrow">ORCHESTRATE ANYTHING.</span>
      <p className="muted">Automations approved by people, run with your own access.</p>
      {cfg?.sso ? (
        <a className="button primary" href={`/auth/login?returnTo=${returnTo}`}>
          Sign in with your organization
        </a>
      ) : cfg?.mode === 'local' ? (
        <div className="signin-instructions">
          <p>Open the sign-in link that Dittoly printed when it started.</p>
          <p className="muted">Running locally? Find the link in the terminal where you ran <code>npm start</code>.</p>
          <p className="muted">If Dittoly runs in Docker, find it with <code>docker compose logs dittoly</code>.</p>
        </div>
      ) : (
        <p>Single sign-on is not configured on this server. Ask your administrator.</p>
      )}
    </main>
  );
}

function App() {
  const path = usePath();
  const [state, setState] = useState<{ me: Me; cfg: AuthConfig } | 'anon' | null>(null);
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('dittoly-sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  /** Groups the person folded or unfolded; the rest keep their default. */
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(folded)); } catch { /* Groups still fold without storage. */ }
  }, [folded]);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('dittoly-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('dittoly-theme', theme); } catch { /* Theme still works without storage. */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem('dittoly-sidebar-collapsed', String(sidebarCollapsed)); } catch { /* Sidebar still works without storage. */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(o => !o); }
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    authConfig()
      .then(async (c) => {
        setCfg(c);
        const me = await api<Me>('/me');
        setState({ me, cfg: c });
      })
      .catch((e) => setState(e instanceof ApiError && e.status === 401 ? 'anon' : 'anon'));
  }, []);
  useEffect(() => {
    setMenuOpen(false);
  }, [path]);
  useEffect(() => { document.title = `${NAV_ALL.find(({ to }) => to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`))?.label ?? 'Dittoly'} | Dittoly`; }, [path]);

  if (state === null) return <div className="app-loading"><Icon name="layers" size={32}/><span>Opening your workspace…</span></div>;
  if (state === 'anon') return <SignIn cfg={cfg} />;

  let content: React.ReactNode = <p className="pad">Page not found.</p>;
  for (const [pattern, render] of ROUTES) {
    const params = match(pattern, path);
    if (params) {
      content = render(params);
      break;
    }
  }
  const active = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  const visible = (i: NavItem) => !i.show || i.show(state.me);
  const navLink = ({ to, label, icon, hint }: NavItem) => (
    <Link key={to} to={to} className={active(to) ? 'active' : ''} aria-label={label} title={`${label}: ${hint}`} aria-current={active(to) ? 'page' : undefined}>
      <Icon name={icon}/><span className="nav-label">{label}</span>{active(to) ? <span className="nav-active-dot"/> : null}
    </Link>
  );
  const navGroup = (g: (typeof NAV_GROUPS)[number]) => {
    const items = g.items.filter(visible);
    if (!items.length) return null;
    // The group of the page you are on is always open; an icon-only sidebar shows every entry.
    const here = items.some((i) => active(i.to));
    const open = sidebarCollapsed || here || !(folded[g.id] ?? g.folded ?? false);
    return (
      <div key={g.id} className="nav-group">
        <button type="button" className="nav-group-toggle" aria-expanded={open} aria-controls={`nav-${g.id}`} disabled={here && !sidebarCollapsed} onClick={() => setFolded((f) => ({ ...f, [g.id]: open }))}>
          <span className="nav-group-label">{g.label}</span><Icon name="chevron" size={14} className={open ? 'point-down' : ''}/>
        </button>
        <div id={`nav-${g.id}`} className="nav-group-items" hidden={!open}>{items.map(navLink)}</div>
      </div>
    );
  };

  return (
    <MeContext.Provider value={{ me: state.me, mode: state.cfg.mode }}>
      <TeamProvider>
      <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <header className="topbar">
          <button className="menu-toggle" aria-expanded={menuOpen} aria-controls="main-navigation" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
            <Icon name={menuOpen ? 'close' : 'menu'}/>
          </button>
          <Link to="/" className="brand" aria-label="Dittoly home" title="Dittoly home">
            <span className="brand-mark"><Logo size={24}/></span>
            <span className="brand-name">DITTOLY</span>
            <span className="version-tag">v0.1</span>
          </Link>
          <button className="global-search" onClick={() => setSearchOpen(true)}><Icon name="search" size={17}/><span>Search your workspace…</span><kbd>⌘ K</kbd></button>
          <span className="spacer" />
          <AiModelChip />
          <span className="spacer" />
          <TeamSwitcher />
          <span className="environment-tag"><span className="status-dot"/>{state.cfg.mode === 'local' ? 'LOCAL WORKSPACE' : 'ORGANIZATION'}<span className="environment-online"> / ONLINE</span></span>
          <button className="theme-toggle" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'day' : 'dark'} theme`}><Icon name={theme === 'dark' ? 'sun' : 'moon'}/><span>{theme === 'dark' ? 'Day mode' : 'Dark mode'}</span></button>
          <div className="who"><Avatar name={state.me.handle}/><span><strong>{state.me.handle}</strong><small>{state.me.role} · {state.cfg.mode}</small></span></div>
          {state.cfg.mode === 'shared' ? (
            <button
              className="ghost"
              onClick={async () => {
                await logout();
                location.href = '/';
              }}
            >
              Sign out
            </button>
          ) : null}
        </header>
        <nav id="main-navigation" className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Main">
          <div className="nav-heading">
            <span className="nav-heading-label">MENU</span>
            <button
              className="sidebar-toggle ghost icon-button"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="main-navigation"
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setSidebarCollapsed(o => !o)}
            >
              <Icon name="chevron" size={17} className={sidebarCollapsed ? '' : 'point-left'}/>
            </button>
          </div>
          {navLink(NAV_HOME)}
          {navLink(NAV_CREATE)}
          {NAV_GROUPS.map(navGroup)}
          <div className="nav-bottom">
            {NAV_BOTTOM.filter(visible).map(navLink)}
          </div>
          {state.cfg.mode === 'shared' ? <button className="mobile-signout" onClick={async () => { await logout(); location.href = '/'; }}>Sign out</button> : null}
          <div className="sidebar-foot"><div><Icon name="shield" size={17}/><span>Personal access boundary</span></div><small>Credentials stay in your vault.<br/>Every action has an accountable actor.</small><div className="sidebar-version"><span>DITTOLY v0.1</span><span className="status-dot"/></div></div>
        </nav>
        <Toasts />
        {menuOpen ? <button className="nav-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)}/> : null}
        <main className="content" id="main-content" tabIndex={-1}><ErrorBoundary resetKey={path}>{content}</ErrorBoundary><footer className="console-footer"><span>DITTOLY / ORCHESTRATE ANYTHING</span><span>{state.cfg.mode === 'local' ? 'LOCAL WORKSPACE' : 'SHARED WORKSPACE'} · v0.1.0</span></footer></main>
        <BuildPanel />
        {searchOpen ? <CommandSearch onClose={() => setSearchOpen(false)} admin={state.me.role === 'admin'}/> : null}
      </div>
      </TeamProvider>
    </MeContext.Provider>
  );
}

// /m is the phone page (paired with a QR code): no portal around it.
const phone = location.pathname === '/m' || location.pathname.startsWith('/m/');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {phone ? <MobileApp /> : <App />}
  </StrictMode>,
);

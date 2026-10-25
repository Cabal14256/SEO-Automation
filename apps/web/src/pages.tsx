import { demoTaskInputSchema } from '@scm/contracts';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  ChevronDown,
  ClipboardList,
  Clock3,
  Files,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ReceiptText,
  RefreshCw,
  Settings,
  Truck,
  Landmark,
  Archive,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type DashboardResponse, type Task, type User } from './api';
import { Button, IconButton, IconLink } from './components/ui/button';
import { Input } from './components/ui/input';
import { Tooltip } from './components/ui/tooltip';
import './navigation.css';

const statusLabels: Record<Task['status'], string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请稍后重试。';
}

function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true"><Package size={22} strokeWidth={2} /></span>
      {!compact && <span className="brand-copy"><strong>发货协同</strong><small>Neo 任务工作台</small></span>}
    </div>
  );
}

export function StatePage({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="state-page">
      <Brand />
      <main className="state-panel" role="status">
        <h1>{title}</h1>
        <p>{detail}</p>
        {action}
      </main>
    </div>
  );
}

export function DashboardRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isError) {
    return <StatePage title="无法打开工作台" detail={messageOf(session.error)} action={<Button icon={RefreshCw} loading={session.isFetching} variant="secondary" type="button" onClick={() => void session.refetch()}>重试</Button>} />;
  }
  if (!session.data.user) return <Navigate to="/login" replace />;
  return <Dashboard user={session.data.user} />;
}

export function LoginRoute() {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });
  if (session.isPending) return <StatePage title="正在验证会话" detail="请稍候…" />;
  if (session.isSuccess && session.data.user) return <Navigate to="/" replace />;
  return <LoginPage initialSessionError={session.isError ? messageOf(session.error) : null} />;
}

function LoginPage({ initialSessionError }: { initialSessionError: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signIn = useMutation({
    mutationFn: () => api.signIn(email.trim(), password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await navigate({ to: '/', replace: true });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (signIn.isPending) return;
    signIn.mutate();
  };

  return (
    <div className="login-page">
      <div className="login-head"><Brand /></div>
      <main className="login-card">
        <p className="section-kicker">局域网业务系统</p>
        <h1>登录发货协同</h1>
        <p className="login-intro">使用管理员账号进入任务工作台。</p>
        <form onSubmit={submit} className="login-form">
          <div className="field">
            <label htmlFor="email">邮箱</label>
            <Input id="email" name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={signIn.isPending} />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={signIn.isPending} />
          </div>
          {initialSessionError && <p className="form-note warning-note" role="status">会话检查失败：{initialSessionError}</p>}
          {signIn.isError && <p className="form-note error-note" role="alert">{messageOf(signIn.error)}</p>}
          <Button icon={LogIn} loading={signIn.isPending} loadingLabel="正在登录…" variant="primary" className="login-submit" type="submit" disabled={signIn.isPending}>
            登录
          </Button>
        </form>
      </main>
    </div>
  );
}

const shippingItems = [
  { view: 'demands', label: '发货工作台', icon: ClipboardList },
  { view: 'documents', label: '发票与单据', icon: Files },
  { view: 'fulfillment', label: '领星单据与分配', icon: ClipboardList },
  { view: 'logistics', label: '物流与交接', icon: Truck },
  { view: 'customs', label: '报关与 9810', icon: Landmark },
  { view: 'archives', label: '批次归档', icon: Archive },
] as const;

function Navigation({ compact = false, onNavigate, onExpand }: { compact?: boolean; onNavigate?: () => void; onExpand?: () => void }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useSearch({ strict: false });
  const shippingActive = ['/shipping', '/imports', '/batches', '/batch-reports'].some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const view = pathname === '/shipping' && (search.view === 'physical' || search.view === 'documents' || search.view === 'fulfillment' || search.view === 'logistics' || search.view === 'customs' || search.view === 'archives') ? search.view : 'demands';
  const [expanded, setExpanded] = useState(shippingActive);
  const submenuId = useId();
  const groupButton = useRef<HTMLButtonElement>(null);
  const focusExpandedGroup = useRef(false);
  useEffect(() => { if (shippingActive) setExpanded(true); }, [shippingActive, pathname, view]);
  useEffect(() => {
    if (!compact && focusExpandedGroup.current) { focusExpandedGroup.current = false; groupButton.current?.focus(); }
  }, [compact]);
  const toggleGroup = () => {
    if (compact) { focusExpandedGroup.current = true; setExpanded(true); onExpand?.(); }
    else setExpanded((previous) => !previous);
  };
  return (
    <nav aria-label="业务导航" className="navigation">
      {!compact && <p className="nav-heading">业务协同</p>}
      {compact
        ? <IconLink className={`nav-link${pathname === '/' ? ' nav-link-active' : ''}`} aria-current={pathname === '/' ? 'page' : undefined} activeProps={{}} activeOptions={{ exact: true }} to="/" onClick={onNavigate} icon={LayoutDashboard} label="工作台" />
        : <Link className={`nav-link${pathname === '/' ? ' nav-link-active' : ''}`} aria-current={pathname === '/' ? 'page' : undefined} activeProps={{}} activeOptions={{ exact: true }} to="/" onClick={onNavigate}><LayoutDashboard size={19} aria-hidden="true" /><span>工作台</span></Link>}
      <div className="navigation-group">
        {compact
          ? <IconButton className={`nav-link navigation-group-toggle${shippingActive ? ' nav-link-active' : ''}`} icon={Package} label="发货管理" data-active={shippingActive} aria-expanded={false} aria-controls={submenuId} onClick={toggleGroup} />
          : <button ref={groupButton} type="button" className="nav-link navigation-group-toggle" data-active={shippingActive} aria-expanded={expanded} aria-controls={submenuId} onClick={toggleGroup}><Package size={19} aria-hidden="true" /><span>发货管理</span><ChevronDown className="navigation-group-chevron" size={16} aria-hidden="true" /></button>}
        <nav id={submenuId} className="navigation-submenu" aria-label="发货管理子导航" hidden={compact || !expanded}>
          {shippingItems.map(({ view: itemView, label, icon: Icon }) => <Link key={itemView} to="/shipping" search={{ view: itemView }} activeProps={{}} className={`nav-link navigation-child-link${shippingActive && view === itemView ? ' nav-link-active' : ''}`} aria-current={shippingActive && view === itemView ? 'page' : undefined} onClick={onNavigate}><Icon size={16} aria-hidden="true" /><span>{label}</span></Link>)}
        </nav>
      </div>
      {compact ? <IconLink to="/finance" icon={ReceiptText} label="费用对账" className={`nav-link${pathname === '/finance' ? ' nav-link-active' : ''}`} aria-current={pathname === '/finance' ? 'page' : undefined} activeProps={{}} onClick={onNavigate} /> : <Link to="/finance" className={`nav-link${pathname === '/finance' ? ' nav-link-active' : ''}`} aria-current={pathname === '/finance' ? 'page' : undefined} activeProps={{}} onClick={onNavigate}><ReceiptText size={19} aria-hidden="true" /><span>费用对账</span></Link>}
    </nav>
  );
}

function SettingsNavigation({ compact = false, mobile = false, onNavigate }: { compact?: boolean; mobile?: boolean; onNavigate?: () => void }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = pathname === '/settings' || pathname.startsWith('/settings/');
  const current = active ? 'page' as const : undefined;
  if (mobile) return <IconLink to="/settings" icon={Settings} label="设置" className={`navigation-settings-mobile${active ? ' navigation-settings-active' : ''}`} aria-current={current} activeProps={{}} onClick={onNavigate} />;
  const className = `nav-link navigation-settings-link${active ? ' nav-link-active' : ''}`;
  return compact
    ? <IconLink to="/settings" icon={Settings} label="设置" className={className} aria-current={current} activeProps={{}} onClick={onNavigate} />
    : <Link to="/settings" className={className} aria-current={current} activeProps={{}} onClick={onNavigate}><Settings size={19} aria-hidden="true" /><span>设置</span></Link>;
}

export function AppShell({ user, children, title = '任务工作台' }: { user: User; children: ReactNode; title?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('scm-sidebar-collapsed') === 'true');
  const [menuOpen, setMenuOpen] = useState(false);
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/login', replace: true });
    },
  });

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem('scm-sidebar-collapsed', String(next));
  };

  return (
    <div className="app-shell antialiased isolate">
      <aside className="sidebar" data-collapsed={collapsed}>
        <Brand compact={collapsed} />
        <Navigation compact={collapsed} onExpand={() => { setCollapsed(false); window.localStorage.setItem('scm-sidebar-collapsed', 'false'); }} />
        <div className="sidebar-foot">
          <nav className="navigation-settings" aria-label="全局设置"><SettingsNavigation compact={collapsed} /></nav>
          <Tooltip label={collapsed ? '展开侧栏' : '收起侧栏'}>{(tip) => <Button {...tip} variant="collapse" type="button"
            icon={collapsed ? PanelLeftOpen : PanelLeftClose} aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={(event) => { tip.onClick?.(event); toggleSidebar(); }}>{!collapsed && <span>收起侧栏</span>}</Button>}</Tooltip>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <IconButton className="mobile-menu-button" type="button" icon={menuOpen ? X : Menu} label={menuOpen ? '关闭导航' : '打开导航'} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(!menuOpen)} />
          <div className="route-name"><span>发货协同</span><strong>{title}</strong></div>
          <div className="account-controls">
            <div className="account-name"><span>{user.name}</span><small>管理员</small></div>
            <SettingsNavigation mobile onNavigate={() => setMenuOpen(false)} />
            <IconButton className="signout-button" type="button" icon={LogOut} label="退出登录" onClick={() => signOut.mutate()} loading={signOut.isPending} />
          </div>
        </header>
        {menuOpen && <div id="mobile-navigation" className="mobile-navigation"><Navigation onNavigate={() => setMenuOpen(false)} /></div>}
        {signOut.isError && <p className="global-error" role="alert">退出失败：{messageOf(signOut.error)}</p>}
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

function Dashboard({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 10_000 });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 5_000 });
  const outstanding = dashboard.data ? dashboard.data.tasks.queued + dashboard.data.tasks.running : null;

  useEffect(() => {
    if ([dashboard.error, tasks.error].some((error) => error instanceof ApiError && error.status === 401)) {
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    }
  }, [dashboard.error, tasks.error, queryClient]);

  return (
    <AppShell user={user}>
      <div className="content-width">
        <section className="overview-banner" aria-labelledby="dashboard-title">
          <div>
            <p className="banner-kicker">SHIPPING / 任务工作台</p>
            <h1 id="dashboard-title">发货任务工作台</h1>
            <p>{outstanding === null ? '正在读取任务状态…' : outstanding === 0 ? '当前没有执行中的任务。' : `当前有 ${outstanding} 项排队或执行中的任务。`}</p>
          </div>
          <span className="milestone-tag">M0 · 运行基础</span>
        </section>

        <section className="summary-section" aria-labelledby="summary-title">
          <div className="section-heading"><h2 id="summary-title">运行概览</h2><span>实时任务记录</span></div>
          {dashboard.isPending ? <div className="summary-loading" role="status">正在加载概览…</div> : dashboard.isError ? <ErrorState title="概览暂时不可用" error={dashboard.error} retry={() => void dashboard.refetch()} /> : <DashboardSummary data={dashboard.data} />}
        </section>

        <CreateTask user={user} />
        <TasksSection query={tasks} />
      </div>
    </AppShell>
  );
}

function DashboardSummary({ data }: { data: DashboardResponse }) {
  const health = data.health.worker;
  return (
    <div className="summary-panel">
      <dl className="metric-grid">
        <div><dt>排队中</dt><dd>{data.tasks.queued}</dd></div>
        <div><dt>执行中</dt><dd>{data.tasks.running}</dd></div>
        <div><dt>已完成</dt><dd>{data.tasks.completed}</dd></div>
        <div><dt>失败</dt><dd className={data.tasks.failed > 0 ? 'metric-danger' : undefined}>{data.tasks.failed}</dd></div>
      </dl>
      <div className="service-row">
        <p><span className="service-dot service-ok" aria-hidden="true" />数据库在线</p>
        <p><span className={`service-dot ${health === 'ok' ? 'service-ok' : health === 'stale' ? 'service-warn' : 'service-unknown'}`} aria-hidden="true" />Worker {health === 'ok' ? '在线' : health === 'stale' ? '心跳过期' : '状态未知'}</p>
      </div>
    </div>
  );
}

function CreateTask({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const permitted = user.role === 'admin';
  const create = useMutation({
    mutationFn: api.createTask,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        void queryClient.invalidateQueries({ queryKey: ['session'] });
      }
    },
    onSuccess: async () => {
      setLabel('');
      setValidationError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending || !permitted) return;
    const parsed = demoTaskInputSchema.safeParse({ label });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? '请输入有效的任务名称。');
      return;
    }
    setValidationError(null);
    create.mutate(parsed.data.label);
  };

  return (
    <section className="content-panel create-panel" aria-labelledby="create-title">
      <div className="section-heading panel-heading"><div><h2 id="create-title">创建验证任务</h2><p>保存任务后，由独立 Worker 处理；结果会出现在下方列表。</p></div></div>
      {permitted ? (
        <form className="create-form" onSubmit={submit}>
          <div className="field task-field"><label htmlFor="task-label">任务名称</label><Input id="task-label" name="task-label" type="text" maxLength={120} value={label} onChange={(event) => { setLabel(event.target.value); setValidationError(null); }} placeholder="例如：验证持久任务" disabled={create.isPending} aria-invalid={Boolean(validationError)} aria-describedby={validationError ? 'task-validation' : undefined} /></div>
          <Button icon={Plus} loading={create.isPending} loadingLabel="正在提交…" variant="primary" type="submit" disabled={create.isPending}>创建任务</Button>
          {validationError && <p id="task-validation" className="form-note error-note" role="alert">{validationError}</p>}
          {create.isError && <p className="form-note error-note" role="alert">{create.error instanceof ApiError && create.error.status === 403 ? '当前账号无权创建任务，请重新登录管理员账号。' : messageOf(create.error)}</p>}
          {create.isSuccess && <p className="form-note success-note" role="status">任务已保存，正在更新列表。</p>}
        </form>
      ) : <p className="permission-note" role="status">请使用管理员账号创建任务。</p>}
    </section>
  );
}

function StatusBadge({ status }: { status: Task['status'] }) {
  const Icon = status === 'completed' ? CircleCheck : status === 'failed' ? CircleX : status === 'running' ? LoaderCircle : Clock3;
  return <span className={`status-badge status-${status}`}><Icon size={15} aria-hidden="true" className={status === 'running' ? 'motion-spin' : undefined} />{statusLabels[status]}</span>;
}

function TasksSection({ query }: { query: UseQueryResult<Task[], Error> }) {
  return (
    <section className="content-panel tasks-panel" aria-labelledby="tasks-title" id="tasks">
      <div className="section-heading panel-heading"><div><h2 id="tasks-title">任务记录</h2><p>按最近提交时间排列；进行中的任务自动刷新。</p></div><IconButton icon={RefreshCw} label="刷新" description="任务记录" type="button" onClick={() => void query.refetch()} loading={query.isFetching} /></div>
      {query.isPending ? <p className="list-state" role="status">正在加载任务…</p> : query.isError ? <ErrorState title="任务列表暂时不可用" error={query.error} retry={() => void query.refetch()} /> : query.data.length === 0 ? <p className="list-state">还没有任务记录。创建验证任务后可在这里查看提交与处理结果。</p> : (
        <div className="table-scroll" role="region" aria-label="任务记录表，可横向滚动" tabIndex={0}><div className="table-inner"><table className="task-table"><thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">提交时间</th><th scope="col">处理结果</th></tr></thead><tbody>{query.data.map((task) => <tr key={task.id}><td><strong>{task.label}</strong><small className="task-id">{task.id}</small></td><td><StatusBadge status={task.status} /></td><td className="time-cell">{dateTime(task.createdAt)}</td><td className="result-cell">{task.status === 'failed' ? <span className="result-error">{task.error || '处理失败，原因未知'}</span> : task.status === 'completed' ? (task.result || '已完成，未返回结果内容') : '等待处理结果'}</td></tr>)}</tbody></table></div></div>
      )}
    </section>
  );
}

function ErrorState({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  return <div className="inline-error" role="alert"><CircleAlert size={20} aria-hidden="true" /><div><strong>{title}</strong><p>{error instanceof ApiError && error.status === 403 ? '当前账号无权查看这项数据，请重新登录管理员账号。' : messageOf(error)}</p></div><Button icon={RefreshCw} variant="secondary" type="button" onClick={retry}>重试</Button></div>;
}

export function NotFoundPage() {
  return <StatePage title="页面不存在" detail="请返回任务工作台。" action={<Link className="secondary-button" to="/">返回工作台</Link>} />;
}

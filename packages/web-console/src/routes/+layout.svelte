<script lang="ts">
  import '../app.css';
  let { children } = $props();

  const navItems = [
    { label: 'Overview', icon: '🏠', href: '/' },
    { label: 'Projects', icon: '📁', href: '/projects' },
    { label: 'System', icon: '⚙️', href: '/system' },
    { label: 'Monitoring', icon: '📊', href: '/monitoring' },
  ];
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <title>SupaCloud Console</title>
</svelte:head>

<div class="layout">
  <aside class="sidebar glass">
    <div class="logo">
      <div class="logo-box">S</div>
      <span>SupaCloud</span>
    </div>

    <nav>
      {#each navItems as item}
        <a href={item.href} class="nav-item">
          <span class="icon">{item.icon}</span>
          <span class="label">{item.label}</span>
        </a>
      {/each}
    </nav>

    <div class="footer">
      <div class="status-indicator">
        <div class="dot"></div>
        System Healthy
      </div>
    </div>
  </aside>

  <main class="content">
    <header class="top-bar">
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search projects..." />
      </div>
      <div class="user-profile">
        <div class="avatar">Admin</div>
      </div>
    </header>
    
    <div class="page-container">
      {@render children()}
    </div>
  </main>
</div>

<style>
  .layout {
    display: flex;
    min-height: 100vh;
  }

  .sidebar {
    width: 260px;
    height: 100vh;
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    padding: 2rem 1.5rem;
    z-index: 100;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 3rem;
  }

  .logo-box {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    color: white;
  }

  .logo span {
    font-size: 1.2rem;
    font-weight: 700;
    background: linear-gradient(to right, #fff, #94a3b8);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 12px;
    color: var(--text-secondary);
    transition: var(--transition);
  }

  .nav-item:hover {
    background: var(--surface-light);
    color: var(--text-primary);
    transform: translateX(4px);
  }

  .nav-item .icon {
    font-size: 1.2rem;
  }

  .footer {
    padding-top: 1rem;
    border-top: 1px solid var(--border-color);
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .dot {
    width: 8px;
    height: 8px;
    background: var(--success-color);
    border-radius: 50%;
    box-shadow: 0 0 8px var(--success-color);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .top-bar {
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2rem;
    border-bottom: 1px solid var(--border-color);
  }

  .search-bar {
    position: relative;
    width: 300px;
  }

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.9rem;
    opacity: 0.5;
  }

  .search-bar input {
    width: 100%;
    background: var(--surface-light);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 10px 12px 10px 40px;
    color: white;
    outline: none;
    transition: var(--transition);
  }

  .search-bar input:focus {
    border-color: var(--primary-color);
    box-shadow: 0 0 10px var(--primary-glow);
  }

  .user-profile {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--surface-light);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid var(--border-color);
  }

  .page-container {
    padding: 2rem;
  }
</style>

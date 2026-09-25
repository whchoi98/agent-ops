(() => {
  try {
    const preference = localStorage.getItem('agent-ops-theme') || 'light';
    const dark = preference === 'dark'
      || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();

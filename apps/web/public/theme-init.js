(() => {
  let preference = 'system';
  try {
    preference = localStorage.getItem('collabboard.appearance') || 'system';
  } catch {
    /* System mode also works when storage is unavailable. */
  }
  document.documentElement.dataset.theme =
    preference === 'dark' ||
    (preference !== 'light' &&
      matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark'
      : 'light';
})();

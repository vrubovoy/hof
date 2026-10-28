// Hof — before the first paint (ARCHITECTURE.md §6): the class `fx-on` on <html> turns the
// animations of the CSS on. It is set only when «Анимации» are on on this device and the system
// does not ask for less motion. An ordinary script in <head>, so the class is there before the
// browser draws the page; without this file, or without the storage, the court stays still.
(() => {
  try {
    const settings = JSON.parse(localStorage.getItem('hof.fx') ?? 'null');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (settings?.anim === true && !reduced) document.documentElement.classList.add('fx-on');
  } catch {
    // No storage (a private window) or a broken value: no animations.
  }
})();

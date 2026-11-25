export function installCarousel(viewport, track, source, control) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const hover = matchMedia("(hover: hover)");
  let frame, index = 0, previous = 0, period = 0, inView = false, paused = false, interactionUntil = 0;

  function animate(time) {
    const elapsed = previous ? Math.min(time - previous, 50) : 0;
    previous = time;
    if (time >= interactionUntil) {
      index = (index + elapsed * .029) % period;
      viewport.scrollLeft = index;
    }
    frame = requestAnimationFrame(animate);
  }
  function synchronize() {
    const run = period > 0 && inView && !paused && !reduceMotion.matches && !document.hidden
      && !(hover.matches && viewport.matches(":hover")) && !viewport.matches(":focus-within");
    if (run && frame === undefined) {
      previous = 0;
      index = viewport.scrollLeft % period;
      frame = requestAnimationFrame(animate);
    } else if (!run && frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  }

  function duplicate(node) {
    const copy = node.cloneNode(true);
    copy.dataset.repeat = "";
    copy.setAttribute("aria-hidden","true");
    for (const button of copy.querySelectorAll("button")) button.tabIndex = -1;
    return copy;
  }
  function rebuild() {
    track.querySelectorAll("[data-repeat]").forEach(node => node.remove());
    period = 0;
    if (!source.children.length || !viewport.clientWidth || reduceMotion.matches) {
      control.hidden = true;
      synchronize();
      return;
    }
    const original = [...source.children];
    const copies = Math.ceil((viewport.clientWidth + 16) / Math.max(1, source.getBoundingClientRect().width));
    for (let count = 1; count < copies; count++) source.append(...original.map(duplicate));
    const second = duplicate(source);
    track.append(second);
    period = second.getBoundingClientRect().left - source.getBoundingClientRect().left;
    index = viewport.scrollLeft % (period || 1);
    control.hidden = !period;
    synchronize();
  }
  control.onclick = () => {
    paused = !paused;
    control.textContent = paused ? "Reanudar" : "Pausar";
    control.setAttribute("aria-pressed",String(paused));
    if (paused) {
      track.querySelectorAll("[data-repeat]").forEach(node => node.remove());
      viewport.scrollLeft = 0;
      synchronize();
    } else rebuild();
  };
  viewport.addEventListener("pointerdown", () => {
    interactionUntil = performance.now() + 4000;
  });
  viewport.addEventListener("scroll", () => {
    if (performance.now() < interactionUntil && period) index = viewport.scrollLeft % period;
  },{ passive:true });
  for (const event of ["pointerenter","pointerleave","focusin","focusout"]) {
    viewport.addEventListener(event, () => queueMicrotask(synchronize));
  }
  new ResizeObserver(() => { if (!paused) rebuild(); }).observe(viewport);
  new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; synchronize(); }).observe(viewport);
  reduceMotion.addEventListener("change",() => { if (!paused) rebuild(); });
  document.addEventListener("visibilitychange",synchronize);
  return () => {
    if (paused) {
      control.hidden = !source.children.length || reduceMotion.matches;
      return;
    }
    rebuild();
  };
}

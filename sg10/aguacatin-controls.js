const closeDelay = 600;
const dragDelay = 400;
const idleDelay = 10_000;

export function bindAvatarGesture(avatar, { expanded, tap, hold, drag, save }) {
  let press, timer;
  let suppressClick = false;

  function perform(current) {
    if (current !== press || current.moved || current.handled || current.open !== expanded()) return;
    current.handled = true;
    suppressClick = true;
    if (current.open) hold();
    else current.dragging = true;
  }

  function begin(id, x, y, touch) {
    if (press) return;
    if (document.activeElement === avatar) avatar.blur();
    const {left,top} = avatar.getBoundingClientRect();
    const open = expanded();
    const current = {id,x,y,left,top,touch,open,started:performance.now()};
    press = current;
    suppressClick = false;
    avatar.classList.toggle("is-held",open);
    timer = setTimeout(() => perform(current),open ? closeDelay : dragDelay);
  }

  function move(x, y) {
    const dx = x - press.x;
    const dy = y - press.y;
    if (press.dragging && !expanded()) {
      drag(press.left + dx,press.top + dy);
      return;
    }
    if (Math.hypot(dx,dy) > (press.open ? 26 : 12)) {
      press.moved = true;
      suppressClick = true;
      clearTimeout(timer);
    }
  }

  function end(released) {
    if (!press) return;
    const current = press;
    if (released && current.open && performance.now() - current.started >= closeDelay) perform(current);
    clearTimeout(timer);
    press = null;
    avatar.classList.remove("is-held");
    if (current.dragging) save();
    if (released && current.touch && !suppressClick && !current.handled) tap(false);
  }

  const activeTouch = event => press?.touch && [...event.changedTouches].find(touch => touch.identifier === press.id);
  avatar.addEventListener("touchstart",event => {
    if (event.cancelable) event.preventDefault();
    if (event.touches.length !== 1) return;
    const touch = event.changedTouches[0];
    begin(touch.identifier,touch.clientX,touch.clientY,true);
  },{passive:false});
  window.addEventListener("touchmove",event => {
    const touch = activeTouch(event);
    if (!touch) return;
    if (event.cancelable) event.preventDefault();
    move(touch.clientX,touch.clientY);
  },{capture:true,passive:false});
  window.addEventListener("touchend",event => {
    if (!activeTouch(event)) return;
    if (event.cancelable) event.preventDefault();
    end(true);
  },{capture:true,passive:false});
  window.addEventListener("touchcancel",event => {
    if (activeTouch(event)) end(false);
  },{capture:true});

  avatar.addEventListener("pointerdown",event => {
    if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0 || press) return;
    begin(event.pointerId,event.clientX,event.clientY,false);
    avatar.setPointerCapture(event.pointerId);
  });
  avatar.addEventListener("pointermove",event => {
    if (press && !press.touch && event.pointerId === press.id) move(event.clientX,event.clientY);
  });
  for (const name of ["pointerup","pointercancel","lostpointercapture"]) {
    avatar.addEventListener(name,event => {
      if (press && !press.touch && event.pointerId === press.id) end(name === "pointerup");
    });
  }

  avatar.addEventListener("contextmenu",event => {
    event.preventDefault();
    if (press?.touch && press.open) perform(press);
  });
  avatar.addEventListener("click",event => {
    if (event.pointerType === "touch" || event.sourceCapabilities?.firesTouchEvents || (event.detail !== 0 && suppressClick)) {
      event.preventDefault();
      return;
    }
    tap(event.detail === 0);
  });
  window.addEventListener("blur",() => end(false));
}

export function bindAvatarIdle(widget, controls, { busy, close }) {
  let timer, waitingForWork = false;

  function check() {
    if (controls.hidden) return;
    if (busy()) {
      waitingForWork = true;
      timer = setTimeout(check,250);
    } else if (waitingForWork) {
      activity();
    } else {
      close();
    }
  }

  function activity() {
    clearTimeout(timer);
    waitingForWork = false;
    if (!controls.hidden) timer = setTimeout(check,idleDelay);
  }

  new MutationObserver(activity).observe(controls,{attributes:true,attributeFilter:["hidden"]});
  for (const name of ["pointerdown","click","keydown","input","focusin","wheel","touchmove"]) {
    widget.addEventListener(name,activity,{capture:true,passive:true});
  }
  activity();
  return activity;
}

/* Mobile hamburger menu: #nav-toggle shows/hides #nav-cluster (the header's
   nav links + language/lights toggles) below the header on narrow screens -
   see the .nav-toggle/.nav-cluster.is-open CSS in style.css, which only
   applies this collapsed behavior under the same max-width: 640px breakpoint
   the rest of the header's mobile layout already uses. No-op on a page
   without both elements. */
(function () {
  var button = document.getElementById("nav-toggle");
  var nav = document.getElementById("nav-cluster");
  if (!button || !nav) return;

  function close() {
    nav.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  }

  button.addEventListener("click", function () {
    var open = nav.classList.toggle("is-open");
    button.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // Closing on an in-menu link/button click covers every nav item (plain
  // links, the logout button, the notification bell's own <details>) so
  // picking something doesn't leave the menu awkwardly open underneath the
  // page it just navigated to/away from.
  nav.addEventListener("click", function (event) {
    if (event.target.closest("a, button:not(#nav-toggle)")) close();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") close();
  });

  document.addEventListener("click", function (event) {
    if (!nav.classList.contains("is-open")) return;
    if (nav.contains(event.target) || button.contains(event.target)) return;
    close();
  });
})();

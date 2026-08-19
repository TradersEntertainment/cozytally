/* Where the server is.

   Empty on the web, which means "wherever this page came from" — the app is
   served by the same process that answers it, so every path stays relative and
   nothing here has to think about it.

   The native build rewrites this one line, because there the app opens from
   its own bundle (capacitor://localhost) and the server is somewhere else
   entirely. That is the whole difference between an app that carries its own
   copy and a window pointed at a website, and Apple's review reads it as the
   difference too. */
window.CT_API = '';

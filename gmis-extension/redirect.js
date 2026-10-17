// Old bookmarks now enter the same multi-account console.
const destination = new URL("multi.html", location.href);
if (new URL(location.href).searchParams.has("preview")) destination.search = "?preview=1";
location.replace(destination.href);

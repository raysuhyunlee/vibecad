const version = new URLSearchParams(location.search).get("version");
if (version) document.getElementById("version").textContent = `v${version}`;

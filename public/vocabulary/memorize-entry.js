(() => {
  if (location.pathname === "/vocabulary/memorize.html") return;

  const createEntry = () => {
    if (document.getElementById("memorizeFloatingEntry")) return;
    const link = document.createElement("a");
    link.id = "memorizeFloatingEntry";
    link.href = "/vocabulary/memorize.html";
    link.textContent = "进入背词训练";
    Object.assign(link.style, {
      position: "fixed",
      right: "16px",
      bottom: "18px",
      zIndex: "9999",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "82px",
      height: "44px",
      padding: "0 16px",
      borderRadius: "999px",
      background: "#111827",
      color: "#fff",
      textDecoration: "none",
      font: '600 15px Arial, "Microsoft YaHei", sans-serif',
      boxShadow: "0 8px 24px rgba(15, 23, 42, .25)",
    });
    document.body.appendChild(link);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createEntry, { once: true });
  } else {
    createEntry();
  }
})();

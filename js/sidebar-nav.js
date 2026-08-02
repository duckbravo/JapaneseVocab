// Sidebar toggle + dropdown behavior shared by every page.

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const body = document.body;
  if (sidebar.style.width === "250px") {
    sidebar.style.width = "0";
    body.classList.remove("sidebar-open");
  } else {
    sidebar.style.width = "250px";
    body.classList.add("sidebar-open");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const dropdowns = document.querySelectorAll(".dropdown-btn");
  dropdowns.forEach(button => {
    button.addEventListener("click", () => {
      const content = button.nextElementSibling;
      content.style.display = content.style.display === "block" ? "none" : "block";
    });
  });
});

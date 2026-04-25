const fileInput = document.querySelector("#file-input");
const uploadForm = document.querySelector("#upload-form");
const selectedFilesContainer = document.querySelector("#selected-files");
const libraryList = document.querySelector("#library-list");
const searchInput = document.querySelector("#search-input");
const formStatus = document.querySelector("#form-status");
const refreshButton = document.querySelector("#refresh-button");
const logoutButton = document.querySelector("#logout-button");
const sessionUserElement = document.querySelector("#session-user");

const totalFilesElement = document.querySelector("#total-files");
const totalStorageElement = document.querySelector("#total-storage");
const bucketStatusElement = document.querySelector("#bucket-status");
const queuedCountElement = document.querySelector("#queued-count");
const selectedSizeElement = document.querySelector("#selected-size");
const imageCountElement = document.querySelector("#image-count");
const videoCountElement = document.querySelector("#video-count");

const selectedFileTemplate = document.querySelector("#selected-file-template");
const libraryItemTemplate = document.querySelector("#library-item-template");

let selectedFiles = [];
let libraryFiles = [];

function getToken() {
  return window.localStorage.getItem("authToken");
}

function clearSession() {
  window.localStorage.removeItem("authToken");
  window.localStorage.removeItem("userRole");
  window.localStorage.removeItem("userName");
}

function redirectToLogin() {
  clearSession();
  window.location.href = "/";
}

async function authFetch(url, options = {}) {
  const token = getToken();

  if (!token) {
    redirectToLogin();
    throw new Error("Login required.");
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });

  if (response.status === 401 || response.status === 403) {
    redirectToLogin();
    throw new Error("Your session has expired.");
  }

  return response;
}

function formatBytes(value) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function getBadgeText(kind) {
  if (kind === "image") return "IMG";
  if (kind === "video") return "VID";
  return "FILE";
}

async function downloadFile(file) {
  formStatus.textContent = `Preparing ${file.name}...`;

  try {
    const response = await authFetch(file.downloadUrl);
    const blob = await response.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(objectUrl);
    formStatus.textContent = `${file.name} downloaded successfully.`;
  } catch (error) {
    formStatus.textContent = error.message;
  }
}

function updateQueueStats() {
  const totalSelectedBytes = selectedFiles.reduce((sum, entry) => sum + entry.file.size, 0);
  queuedCountElement.textContent = String(selectedFiles.length);
  selectedSizeElement.textContent = formatBytes(totalSelectedBytes);
}

function updateLibraryStats() {
  const imageCount = libraryFiles.filter((file) => file.kind === "image").length;
  const videoCount = libraryFiles.filter((file) => file.kind === "video").length;
  imageCountElement.textContent = String(imageCount);
  videoCountElement.textContent = String(videoCount);
}

function renderSelectedFiles() {
  if (!selectedFiles.length) {
    selectedFilesContainer.className = "selected-files empty-state";
    selectedFilesContainer.textContent = "No files selected yet.";
    updateQueueStats();
    return;
  }

  selectedFilesContainer.className = "selected-files";
  selectedFilesContainer.innerHTML = "";

  selectedFiles.forEach((entry, index) => {
    const fragment = selectedFileTemplate.content.cloneNode(true);
    fragment.querySelector(".selected-file-original").textContent = entry.file.name;
    fragment.querySelector(".selected-file-size").textContent = formatBytes(entry.file.size);

    const input = fragment.querySelector(".selected-file-name");
    input.value = entry.customName;
    input.addEventListener("input", (event) => {
      selectedFiles[index].customName = event.target.value;
    });

    selectedFilesContainer.appendChild(fragment);
  });

  updateQueueStats();
}

function renderLibrary() {
  const query = searchInput.value.trim().toLowerCase();
  const files = libraryFiles.filter((file) => file.name.toLowerCase().includes(query));

  if (!files.length) {
    libraryList.innerHTML = '<div class="empty-state">No matching files found in the photography folder.</div>';
    return;
  }

  libraryList.innerHTML = "";

  files.forEach((file) => {
    const fragment = libraryItemTemplate.content.cloneNode(true);
    fragment.querySelector(".file-badge").textContent = getBadgeText(file.kind);
    fragment.querySelector(".library-item-name").textContent = file.name;
    fragment.querySelector(".library-kind").textContent =
      file.kind.charAt(0).toUpperCase() + file.kind.slice(1);
    fragment.querySelector(".library-size").textContent = file.sizeLabel;
    fragment.querySelector(".library-item-meta").textContent = formatDate(file.lastModified);

    const downloadLink = fragment.querySelector(".download-link");
    downloadLink.href = "#";
    downloadLink.addEventListener("click", async (event) => {
      event.preventDefault();
      await downloadFile(file);
    });

    const deleteButton = fragment.querySelector(".delete-button");
    deleteButton.addEventListener("click", async () => {
      const firstConfirm = window.confirm(`Delete "${file.name}" from the website library?`);
      if (!firstConfirm) {
        return;
      }

      const secondConfirm = window.confirm(
        `Please confirm again. This will permanently delete "${file.name}" from the photography folder.`
      );
      if (!secondConfirm) {
        return;
      }

      formStatus.textContent = `Deleting ${file.name}...`;

      try {
        const response = await authFetch("/api/photography/files", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ key: file.key })
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.details || data.message || "Delete failed.");
        }

        formStatus.textContent = data.message;
        await fetchLibrary();
      } catch (error) {
        formStatus.textContent = error.message;
      }
    });

    libraryList.appendChild(fragment);
  });
}

async function fetchHealth() {
  try {
    const response = await authFetch("/api/photography/health");
    const data = await response.json();
    bucketStatusElement.textContent = data.ok ? "Connected" : "Error";
  } catch (_error) {
    bucketStatusElement.textContent = "Offline";
  }
}

async function fetchLibrary() {
  libraryList.innerHTML = '<div class="empty-state">Loading files from the photography folder...</div>';

  try {
    const response = await authFetch("/api/photography/files");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.message || "Failed to load files.");
    }

    libraryFiles = data.files;
    totalFilesElement.textContent = data.summary.totalFiles;
    totalStorageElement.textContent = data.summary.totalSizeLabel;
    updateLibraryStats();
    renderLibrary();
  } catch (error) {
    libraryList.innerHTML = `<div class="empty-state">${error.message}</div>`;
    libraryFiles = [];
    totalFilesElement.textContent = "0";
    totalStorageElement.textContent = "0 B";
    updateLibraryStats();
  }
}

fileInput.addEventListener("change", (event) => {
  selectedFiles = Array.from(event.target.files).map((file) => ({
    file,
    customName: file.name.replace(/\.[^.]+$/, "")
  }));
  renderSelectedFiles();
});

searchInput.addEventListener("input", renderLibrary);
refreshButton.addEventListener("click", fetchLibrary);
logoutButton.addEventListener("click", redirectToLogin);

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!selectedFiles.length) {
    formStatus.textContent = "Choose at least one photo or video first.";
    return;
  }

  const formData = new FormData();
  selectedFiles.forEach((entry) => {
    formData.append("files", entry.file);
    formData.append("names", entry.customName.trim());
  });

  formStatus.textContent = "Uploading files to the photography folder...";

  try {
    const response = await authFetch("/api/photography/upload", {
      method: "POST",
      body: formData
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.message || "Upload failed.");
    }

    formStatus.textContent = data.message;
    selectedFiles = [];
    fileInput.value = "";
    renderSelectedFiles();
    await fetchLibrary();
  } catch (error) {
    formStatus.textContent = error.message;
  }
});

async function loadSession() {
  try {
    const response = await authFetch("/api/photography/session");
    const data = await response.json();
    sessionUserElement.textContent = data.name || data.email || "Photography user";
  } catch (_error) {
    sessionUserElement.textContent = "Photography user";
  }
}

loadSession();
fetchHealth();
updateQueueStats();
updateLibraryStats();
fetchLibrary();

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
const uploadProgressSummaryElement = document.querySelector("#upload-progress-summary");

const selectedFileTemplate = document.querySelector("#selected-file-template");
const libraryItemTemplate = document.querySelector("#library-item-template");

let selectedFiles = [];
let libraryFiles = [];

function createSelectedFileEntry(file) {
  return {
    file,
    customName: file.name.replace(/\.[^.]+$/, ""),
    status: "queued",
    uploadedBytes: 0,
    progress: 0,
    errorMessage: ""
  };
}

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

function updateUploadProgressSummary() {
  if (!selectedFiles.length) {
    uploadProgressSummaryElement.textContent = "Large uploads supported up to 100 GB per file.";
    return;
  }

  const uploadedBytes = selectedFiles.reduce((sum, entry) => sum + entry.uploadedBytes, 0);
  const totalBytes = selectedFiles.reduce((sum, entry) => sum + entry.file.size, 0);
  const completedCount = selectedFiles.filter((entry) => entry.status === "completed").length;
  const failedCount = selectedFiles.filter((entry) => entry.status === "error").length;

  uploadProgressSummaryElement.textContent =
    `${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)} uploaded. ` +
    `${completedCount}/${selectedFiles.length} finished` +
    (failedCount ? `, ${failedCount} failed.` : ".");
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
    updateUploadProgressSummary();
    return;
  }

  selectedFilesContainer.className = "selected-files";
  selectedFilesContainer.innerHTML = "";

  selectedFiles.forEach((entry, index) => {
    const fragment = selectedFileTemplate.content.cloneNode(true);
    fragment.querySelector(".selected-file-original").textContent = entry.file.name;
    fragment.querySelector(".selected-file-size").textContent = formatBytes(entry.file.size);
    fragment.querySelector(".selected-file-status").textContent =
      entry.status === "uploading"
        ? "Uploading now"
        : entry.status === "completed"
          ? "Uploaded"
          : entry.status === "error"
            ? entry.errorMessage || "Upload failed"
            : "Ready to upload";

    const progressBar = fragment.querySelector(".selected-file-progress-bar");
    progressBar.style.width = `${Math.max(0, Math.min(entry.progress * 100, 100))}%`;

    fragment.querySelector(".selected-file-progress-text").textContent =
      `${formatBytes(entry.uploadedBytes)} of ${formatBytes(entry.file.size)} (${Math.round(entry.progress * 100)}%)`;

    const input = fragment.querySelector(".selected-file-name");
    input.value = entry.customName;
    input.disabled = entry.status === "uploading" || entry.status === "completed";
    input.addEventListener("input", (event) => {
      selectedFiles[index].customName = event.target.value;
    });

    selectedFilesContainer.appendChild(fragment);
  });

  updateQueueStats();
  updateUploadProgressSummary();
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
  const incomingFiles = Array.from(event.target.files).map(createSelectedFileEntry);
  selectedFiles = [...selectedFiles, ...incomingFiles];
  fileInput.value = "";
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

  const queuedEntries = selectedFiles.filter((entry) => entry.status !== "completed");
  let completedNow = 0;
  let failedNow = 0;

  formStatus.textContent = `Uploading ${queuedEntries.length} file${queuedEntries.length === 1 ? "" : "s"} to the photography folder...`;

  try {
    for (const entry of queuedEntries) {
      entry.status = "uploading";
      entry.errorMessage = "";
      entry.uploadedBytes = 0;
      entry.progress = 0;
      renderSelectedFiles();

      try {
        await uploadFile(entry);
        entry.status = "completed";
        entry.uploadedBytes = entry.file.size;
        entry.progress = 1;
        completedNow += 1;
      } catch (error) {
        entry.status = "error";
        entry.errorMessage = error.message;
        failedNow += 1;
      }

      renderSelectedFiles();
    }

    if (completedNow > 0) {
      await fetchLibrary();
    }

    formStatus.textContent =
      failedNow > 0
        ? `${completedNow} uploaded, ${failedNow} failed. You can retry the failed files.`
        : `All ${completedNow} file${completedNow === 1 ? "" : "s"} uploaded successfully.`;

    selectedFiles = selectedFiles.filter((entry) => entry.status === "error");
    renderSelectedFiles();
  } catch (error) {
    formStatus.textContent = error.message;
  }
});

function uploadFile(entry) {
  const token = getToken();

  if (!token) {
    redirectToLogin();
    return Promise.reject(new Error("Login required."));
  }

  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("files", entry.file);
    formData.append("names", entry.customName.trim());

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/photography/upload");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      entry.uploadedBytes = Math.min(event.loaded, entry.file.size);
      entry.progress = Math.min(event.loaded / event.total, 1);
      renderSelectedFiles();
    });

    xhr.addEventListener("load", () => {
      const data = parseJsonResponse(xhr.responseText);

      if (xhr.status === 401 || xhr.status === 403) {
        redirectToLogin();
        reject(new Error("Your session has expired."));
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.details || data.message || "Upload failed."));
        return;
      }

      resolve(data);
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Upload failed because the network connection was interrupted."));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload was cancelled."));
    });

    xhr.send(formData);
  });
}

function parseJsonResponse(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (_error) {
    return {};
  }
}

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
updateUploadProgressSummary();
updateLibraryStats();
fetchLibrary();

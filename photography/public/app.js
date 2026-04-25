const fileInput = document.querySelector("#file-input");
const folderInput = document.querySelector("#folder-input");
const folderPickerButton = document.querySelector("#folder-picker-button");
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
const expandedFolderPaths = new Set([""]);
const expandedLibraryPaths = new Set([""]);
const activePreviewUrls = new Map();
const folderVisibleCounts = new Map([["", 0]]);
const INITIAL_FOLDER_FILE_RENDER_COUNT = 24;
const FOLDER_FILE_RENDER_STEP = 24;
const MAX_BATCH_FILES = 10;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_RETRIES = 2;
const UPLOAD_CONCURRENCY = 3;
const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
const MULTIPART_PART_CONCURRENCY = 4;
const MULTIPART_PART_RETRIES = 2;
const MIN_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const UPLOAD_TIMEOUT_MIN_BYTES_PER_SECOND = 256 * 1024;

function createSelectedFileEntry(file) {
  const relativePath = file.webkitRelativePath || file.name;
  return {
    file,
    relativePath,
    status: "queued",
    uploadedBytes: 0,
    progress: 0,
    errorMessage: "",
    retries: 0
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

function getEntryKind(entry) {
  if (entry.file.type.startsWith("image/")) return "image";
  if (entry.file.type.startsWith("video/")) return "video";
  return "file";
}

function shouldUseMultipart(entry) {
  return entry.file.size >= MULTIPART_THRESHOLD_BYTES;
}

function getUploadTimeoutMs(size) {
  const computedTimeout = Math.ceil((size / UPLOAD_TIMEOUT_MIN_BYTES_PER_SECOND) * 1000) + 30 * 1000;
  return Math.max(MIN_UPLOAD_TIMEOUT_MS, Math.min(MAX_UPLOAD_TIMEOUT_MS, computedTimeout));
}

function revokeAllActivePreviewUrls() {
  activePreviewUrls.forEach((previewUrl) => {
    URL.revokeObjectURL(previewUrl);
  });
  activePreviewUrls.clear();
}

function getEntryPreviewUrl(entry) {
  if (activePreviewUrls.has(entry.relativePath)) {
    return activePreviewUrls.get(entry.relativePath);
  }

  const previewUrl = URL.createObjectURL(entry.file);
  activePreviewUrls.set(entry.relativePath, previewUrl);
  return previewUrl;
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

function createSelectionTree(entries) {
  const root = {
    path: "",
    name: "root",
    folders: new Map(),
    files: []
  };

  entries.forEach((entry) => {
    const segments = entry.relativePath.split("/").filter(Boolean);
    const fileName = segments.pop() || entry.file.name;
    let currentNode = root;
    let currentPath = "";

    segments.forEach((segment) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!currentNode.folders.has(segment)) {
        currentNode.folders.set(segment, {
          path: currentPath,
          name: segment,
          folders: new Map(),
          files: []
        });
      }
      currentNode = currentNode.folders.get(segment);
    });

    currentNode.files.push({
      ...entry,
      displayName: fileName
    });
  });

  return root;
}

function createLibraryTree(files) {
  const root = {
    path: "",
    name: "root",
    folders: new Map(),
    files: []
  };

  files.forEach((file) => {
    const relativePath = String(file.relativePath || file.name || "").replace(/^\/+|\/+$/g, "");
    const segments = relativePath.split("/").filter(Boolean);
    const fileName = segments.pop() || file.name;
    let currentNode = root;
    let currentPath = "";

    segments.forEach((segment) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!currentNode.folders.has(segment)) {
        currentNode.folders.set(segment, {
          path: currentPath,
          name: segment,
          folders: new Map(),
          files: []
        });
      }
      currentNode = currentNode.folders.get(segment);
    });

    currentNode.files.push({
      ...file,
      displayName: fileName
    });
  });

  return root;
}

function renderSelectedFileEntry(entry) {
  const fragment = selectedFileTemplate.content.cloneNode(true);
  const previewImage = fragment.querySelector(".selected-file-preview-image");
  const previewVideo = fragment.querySelector(".selected-file-preview-video");
  const previewFallback = fragment.querySelector(".selected-file-preview-fallback");
  const entryKind = getEntryKind(entry);

  if ((entryKind === "image" || entryKind === "video") && entry.file.size <= 100 * 1024 * 1024) {
    const previewUrl = getEntryPreviewUrl(entry);
    if (entryKind === "image") {
      previewImage.src = previewUrl;
      previewImage.hidden = false;
      previewFallback.hidden = true;
    } else {
      previewVideo.src = previewUrl;
      previewVideo.hidden = false;
      previewFallback.hidden = true;
      previewFallback.textContent = "VIDEO";
    }
  } else {
    previewFallback.textContent = getBadgeText(entryKind);
  }

  fragment.querySelector(".selected-file-original").textContent = entry.displayName || entry.relativePath;
  fragment.querySelector(".selected-file-size").textContent = `${entryKind.toUpperCase()} • ${formatBytes(entry.file.size)}`;
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
  input.value = entry.relativePath;
  input.disabled = true;

  return fragment;
}

function countTreeStats(node) {
  let folderCount = 0;
  let fileCount = node.files.length;

  node.folders.forEach((childNode) => {
    const childStats = countTreeStats(childNode);
    folderCount += 1 + childStats.folderCount;
    fileCount += childStats.fileCount;
  });

  return { folderCount, fileCount };
}

function getVisibleFileCountForFolder(folderPath, totalFiles) {
  if (totalFiles <= 0) {
    return 0;
  }

  if (!folderVisibleCounts.has(folderPath)) {
    folderVisibleCounts.set(folderPath, Math.min(INITIAL_FOLDER_FILE_RENDER_COUNT, totalFiles));
  }

  return Math.min(folderVisibleCounts.get(folderPath), totalFiles);
}

function renderSelectionTreeNode(node, level = 0) {
  const wrapper = document.createElement("div");
  wrapper.className = "selection-tree-node";

  const sortedFolders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
  const sortedFiles = [...node.files].sort((a, b) => (a.displayName || a.relativePath).localeCompare(b.displayName || b.relativePath));
  const visibleFileCount = getVisibleFileCountForFolder(node.path, sortedFiles.length);
  const visibleFiles = sortedFiles.slice(0, visibleFileCount);

  sortedFolders.forEach((childNode) => {
    const folderStats = countTreeStats(childNode);
    const folderElement = document.createElement("div");
    folderElement.className = "selection-folder";

    const folderButton = document.createElement("button");
    folderButton.type = "button";
    folderButton.className = "selection-folder-toggle";
    folderButton.style.setProperty("--folder-level", String(level));
    folderButton.innerHTML = `
      <span class="selection-folder-caret">${expandedFolderPaths.has(childNode.path) ? "▾" : "▸"}</span>
      <span class="selection-folder-name">${childNode.name}</span>
      <span class="selection-folder-meta">${folderStats.fileCount} files${folderStats.folderCount ? ` • ${folderStats.folderCount} folders` : ""}</span>
    `;
    folderButton.addEventListener("click", () => {
      if (expandedFolderPaths.has(childNode.path)) {
        expandedFolderPaths.delete(childNode.path);
      } else {
        expandedFolderPaths.add(childNode.path);
        getVisibleFileCountForFolder(childNode.path, childNode.files.length);
      }
      renderSelectedFiles();
    });

    folderElement.appendChild(folderButton);

    if (expandedFolderPaths.has(childNode.path)) {
      const childContent = document.createElement("div");
      childContent.className = "selection-folder-children";
      childContent.appendChild(renderSelectionTreeNode(childNode, level + 1));
      folderElement.appendChild(childContent);
    }

    wrapper.appendChild(folderElement);
  });

  visibleFiles.forEach((entry) => {
    const fileWrapper = document.createElement("div");
    fileWrapper.className = "selection-file-wrapper";
    fileWrapper.style.setProperty("--file-level", String(level));
    fileWrapper.appendChild(renderSelectedFileEntry(entry));
    wrapper.appendChild(fileWrapper);
  });

  if (visibleFileCount < sortedFiles.length) {
    const loadMoreButton = document.createElement("button");
    loadMoreButton.type = "button";
    loadMoreButton.className = "selection-load-more";
    loadMoreButton.style.setProperty("--file-level", String(level));
    loadMoreButton.textContent = `Load more files (${sortedFiles.length - visibleFileCount} remaining)`;
    loadMoreButton.addEventListener("click", () => {
      folderVisibleCounts.set(
        node.path,
        Math.min(visibleFileCount + FOLDER_FILE_RENDER_STEP, sortedFiles.length)
      );
      renderSelectedFiles();
    });
    wrapper.appendChild(loadMoreButton);
  }

  return wrapper;
}

function renderSelectedFiles() {
  revokeAllActivePreviewUrls();

  if (!selectedFiles.length) {
    selectedFilesContainer.className = "selected-files empty-state";
    selectedFilesContainer.textContent = "No files selected yet.";
    updateQueueStats();
    updateUploadProgressSummary();
    return;
  }

  const tree = createSelectionTree(selectedFiles);
  selectedFilesContainer.className = "selected-files";
  selectedFilesContainer.innerHTML = "";
  selectedFilesContainer.appendChild(renderSelectionTreeNode(tree));

  updateQueueStats();
  updateUploadProgressSummary();
}

function renderLibraryFileEntry(file) {
  const fragment = libraryItemTemplate.content.cloneNode(true);
  fragment.querySelector(".file-badge").textContent = getBadgeText(file.kind);
  fragment.querySelector(".library-item-name").textContent = file.displayName || file.relativePath || file.name;
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
    const firstConfirm = window.confirm(`Delete "${file.relativePath || file.name}" from the website library?`);
    if (!firstConfirm) {
      return;
    }

    const secondConfirm = window.confirm(
      `Please confirm again. This will permanently delete "${file.relativePath || file.name}" from the photography folder.`
    );
    if (!secondConfirm) {
      return;
    }

    formStatus.textContent = `Deleting ${file.relativePath || file.name}...`;

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

  return fragment;
}

function renderLibraryTreeNode(node, level = 0) {
  const wrapper = document.createElement("div");
  wrapper.className = "library-tree-node";

  const sortedFolders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
  const sortedFiles = [...node.files].sort((a, b) => (a.displayName || a.relativePath).localeCompare(b.displayName || b.relativePath));

  sortedFolders.forEach((childNode) => {
    const folderStats = countTreeStats(childNode);
    const folderElement = document.createElement("div");
    folderElement.className = "library-folder";

    const folderButton = document.createElement("button");
    folderButton.type = "button";
    folderButton.className = "library-folder-toggle";
    folderButton.style.setProperty("--folder-level", String(level));
    folderButton.innerHTML = `
      <span class="library-folder-caret">${expandedLibraryPaths.has(childNode.path) ? "▾" : "▸"}</span>
      <span class="library-folder-name">${childNode.name}</span>
      <span class="library-folder-meta">${folderStats.fileCount} files${folderStats.folderCount ? ` • ${folderStats.folderCount} folders` : ""}</span>
    `;
    folderButton.addEventListener("click", () => {
      if (expandedLibraryPaths.has(childNode.path)) {
        expandedLibraryPaths.delete(childNode.path);
      } else {
        expandedLibraryPaths.add(childNode.path);
      }
      renderLibrary();
    });

    folderElement.appendChild(folderButton);

    if (expandedLibraryPaths.has(childNode.path)) {
      const childContent = document.createElement("div");
      childContent.className = "library-folder-children";
      childContent.appendChild(renderLibraryTreeNode(childNode, level + 1));
      folderElement.appendChild(childContent);
    }

    wrapper.appendChild(folderElement);
  });

  sortedFiles.forEach((file) => {
    const fileWrapper = document.createElement("div");
    fileWrapper.className = "library-file-wrapper";
    fileWrapper.style.setProperty("--file-level", String(level));
    fileWrapper.appendChild(renderLibraryFileEntry(file));
    wrapper.appendChild(fileWrapper);
  });

  return wrapper;
}

function renderLibrary() {
  const query = searchInput.value.trim().toLowerCase();
  const files = libraryFiles.filter((file) => {
    const haystack = `${file.name} ${file.relativePath || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  if (!files.length) {
    libraryList.innerHTML = '<div class="empty-state">No matching files found in the photography folder.</div>';
    return;
  }

  libraryList.innerHTML = "";
  const tree = createLibraryTree(files);
  libraryList.appendChild(renderLibraryTreeNode(tree));
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

function addSelectedFiles(fileList) {
  const incomingFiles = Array.from(fileList).map(createSelectedFileEntry);
  selectedFiles = [...selectedFiles, ...incomingFiles];
  renderSelectedFiles();
}

fileInput.addEventListener("change", (event) => {
  addSelectedFiles(event.target.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", (event) => {
  addSelectedFiles(event.target.files);
  folderInput.value = "";
});

folderPickerButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  folderInput.click();
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
  const multipartEntries = queuedEntries.filter(shouldUseMultipart);
  const regularEntries = queuedEntries.filter((entry) => !shouldUseMultipart(entry));
  let uploadedCount = 0;
  const failedEntries = [];

  formStatus.textContent =
    `Uploading ${queuedEntries.length} item${queuedEntries.length === 1 ? "" : "s"} in ` +
    `${queuedEntries.length} upload job${queuedEntries.length === 1 ? "" : "s"}...`;

  try {
    for (const entry of queuedEntries) {
      entry.status = "uploading";
      entry.errorMessage = "";
      entry.uploadedBytes = 0;
      entry.progress = 0;
    }
    renderSelectedFiles();

    const uploadJobs = [
      ...regularEntries.map((entry) => ({
        run: () => uploadDirectFileWithRetry(entry),
        label: entry.relativePath
      })),
      ...multipartEntries.map((entry) => ({
        run: () => uploadLargeFileWithMultipart(entry),
        label: entry.relativePath
      }))
    ];

    const uploadResults = await runBatchesWithConcurrency(uploadJobs, async (job, jobIndex) => {
      formStatus.textContent =
        `Running upload job ${jobIndex + 1} of ${uploadJobs.length} ` +
        `(${uploadedCount}/${queuedEntries.length} items finished)...`;

      return job.run();
    });

    uploadResults.forEach((result) => {
      for (const entry of result.uploadedEntries) {
        entry.status = "completed";
        entry.uploadedBytes = entry.file.size;
        entry.progress = 1;
        uploadedCount += 1;
      }

      for (const failure of result.failedEntries) {
        failure.entry.status = "error";
        failure.entry.progress = 0;
        failure.entry.uploadedBytes = 0;
        failure.entry.errorMessage = failure.error.message;
        failedEntries.push(failure.entry);
      }
    });

    renderSelectedFiles();

    await fetchLibrary();

    formStatus.textContent = failedEntries.length
      ? `${uploadedCount} uploaded, ${failedEntries.length} failed. Failed files stayed in the queue for retry.`
      : `Folder uploaded successfully with ${queuedEntries.length} item${queuedEntries.length === 1 ? "" : "s"}.`;

    selectedFiles = selectedFiles.filter((entry) => entry.status === "error");
    renderSelectedFiles();
  } catch (error) {
    for (const entry of queuedEntries.filter((item) => item.status !== "completed")) {
      entry.status = "error";
      entry.errorMessage = error.message;
    }
    renderSelectedFiles();
    formStatus.textContent =
      uploadedCount > 0
        ? `${uploadedCount} uploaded before the connection failed. ${error.message}`
        : error.message;
  }
});

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function runBatchesWithConcurrency(items, worker, concurrency = UPLOAD_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );

  await Promise.all(workers);
  return results;
}

async function uploadDirectFileWithRetry(entry, attempt = 0) {
  try {
    entry.retries = attempt;
    entry.status = "uploading";
    if (attempt > 0) {
      entry.errorMessage = `Retrying upload (${attempt}/${MAX_BATCH_RETRIES})...`;
      entry.uploadedBytes = 0;
      entry.progress = 0;
      renderSelectedFiles();
    }

    const signedUpload = await initializeDirectUpload(entry);
    await uploadDirectFileToS3(entry, signedUpload);
    return {
      uploadedEntries: [entry],
      failedEntries: []
    };
  } catch (error) {
    if (shouldFallbackToServerUpload(error)) {
      try {
        entry.errorMessage = "Browser-to-S3 upload failed, retrying through the server...";
        renderSelectedFiles();
        await uploadDirectFileViaServer(entry);
        return {
          uploadedEntries: [entry],
          failedEntries: []
        };
      } catch (relayError) {
        error = relayError;
      }
    }

    if (attempt >= MAX_BATCH_RETRIES) {
      return {
        uploadedEntries: [],
        failedEntries: [{ entry, error }]
      };
    }

    await wait(600 * (attempt + 1));
    return uploadDirectFileWithRetry(entry, attempt + 1);
  }
}

async function initializeDirectUpload(entry) {
  const response = await authFetch("/api/photography/direct-upload/sign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fileName: entry.file.name,
      relativePath: entry.relativePath,
      contentType: entry.file.type || "application/octet-stream"
    })
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.details || data.message || "Failed to prepare direct upload.");
  }

  return data;
}

function uploadDirectFileToS3(entry, signedUpload) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUpload.signedUrl);
    xhr.timeout = getUploadTimeoutMs(entry.file.size);
    xhr.setRequestHeader("Content-Type", entry.file.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      entry.uploadedBytes = Math.min(event.loaded, entry.file.size);
      entry.progress = entry.file.size > 0 ? Math.min(entry.uploadedBytes / entry.file.size, 1) : 0;
      renderSelectedFiles();
    });

    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error("Direct upload failed while sending the file to S3."));
        return;
      }

      entry.uploadedBytes = entry.file.size;
      entry.progress = 1;
      renderSelectedFiles();
      resolve();
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Direct upload failed because the S3 connection was interrupted."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Direct upload timed out before the file finished transferring."));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Direct upload was cancelled."));
    });

    xhr.send(entry.file);
  });
}

function shouldFallbackToServerUpload(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("connection was interrupted") ||
    message.includes("timed out") ||
    message.includes("failed while sending the file to s3")
  );
}

function uploadDirectFileViaServer(entry) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) {
      redirectToLogin();
      reject(new Error("Login required."));
      return;
    }

    const formData = new FormData();
    formData.append("files", entry.file, entry.file.name);
    formData.append("paths", entry.relativePath);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/photography/upload");
    xhr.timeout = getUploadTimeoutMs(entry.file.size);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      entry.uploadedBytes = Math.min(event.loaded, entry.file.size);
      entry.progress = entry.file.size > 0 ? Math.min(entry.uploadedBytes / entry.file.size, 1) : 0;
      renderSelectedFiles();
    });

    xhr.addEventListener("load", () => {
      let responseData = null;

      try {
        responseData = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch (_error) {
        responseData = null;
      }

      if (xhr.status === 401 || xhr.status === 403) {
        redirectToLogin();
        reject(new Error("Your session has expired."));
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            responseData?.details ||
            responseData?.message ||
            "Fallback upload through the server failed."
          )
        );
        return;
      }

      entry.uploadedBytes = entry.file.size;
      entry.progress = 1;
      renderSelectedFiles();
      resolve(responseData);
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Fallback upload through the server failed because the connection was interrupted."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Fallback upload through the server timed out before the file finished transferring."));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Fallback upload through the server was cancelled."));
    });

    xhr.send(formData);
  });
}

async function uploadLargeFileWithMultipart(entry) {
  let initializedUpload = null;

  try {
    initializedUpload = await initializeMultipartUpload(entry);
    const parts = await uploadMultipartParts(entry, initializedUpload);
    await completeMultipartUpload(initializedUpload, parts);

    return {
      uploadedEntries: [entry],
      failedEntries: []
    };
  } catch (error) {
    if (initializedUpload?.uploadId) {
      await abortMultipartUpload(initializedUpload).catch(() => {});
    }

    return {
      uploadedEntries: [],
      failedEntries: [{ entry, error }]
    };
  }
}

async function initializeMultipartUpload(entry) {
  const response = await authFetch("/api/photography/multipart/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fileName: entry.file.name,
      relativePath: entry.relativePath,
      contentType: entry.file.type || "application/octet-stream",
      size: entry.file.size
    })
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.details || data.message || "Failed to initialize multipart upload.");
  }

  return data;
}

async function uploadMultipartParts(entry, initializedUpload) {
  const totalParts = Math.ceil(entry.file.size / initializedUpload.partSize);
  const loadedParts = new Map();
  const completedParts = [];
  const partNumbers = Array.from({ length: totalParts }, (_, index) => index + 1);

  await runBatchesWithConcurrency(
    partNumbers,
    async (partNumber) => {
      const part = await uploadMultipartPartWithRetry(entry, initializedUpload, partNumber, loadedParts);
      completedParts.push(part);
    },
    MULTIPART_PART_CONCURRENCY
  );

  return completedParts.sort((a, b) => a.PartNumber - b.PartNumber);
}

async function uploadMultipartPartWithRetry(entry, initializedUpload, partNumber, loadedParts, attempt = 0) {
  try {
    if (attempt > 0) {
      loadedParts.delete(partNumber);
      updateMultipartEntryProgress(entry, loadedParts);
    }

    return await uploadMultipartPart(entry, initializedUpload, partNumber, loadedParts);
  } catch (error) {
    if (attempt >= MULTIPART_PART_RETRIES) {
      throw error;
    }

    await wait(700 * (attempt + 1));
    return uploadMultipartPartWithRetry(entry, initializedUpload, partNumber, loadedParts, attempt + 1);
  }
}

async function uploadMultipartPart(entry, initializedUpload, partNumber, loadedParts) {
  const signResponse = await authFetch("/api/photography/multipart/sign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      key: initializedUpload.key,
      uploadId: initializedUpload.uploadId,
      partNumber
    })
  });
  const signData = await signResponse.json();

  if (!signResponse.ok) {
    throw new Error(signData.details || signData.message || "Failed to sign multipart upload part.");
  }

  const start = (partNumber - 1) * initializedUpload.partSize;
  const end = Math.min(start + initializedUpload.partSize, entry.file.size);
  const blob = entry.file.slice(start, end);

  return putMultipartPart(entry, blob, signData.signedUrl, partNumber, loadedParts);
}

function putMultipartPart(entry, blob, signedUrl, partNumber, loadedParts) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    xhr.timeout = getUploadTimeoutMs(blob.size);
    xhr.setRequestHeader("Content-Type", entry.file.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      loadedParts.set(partNumber, event.loaded);
      updateMultipartEntryProgress(entry, loadedParts);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error("A multipart upload part failed to reach S3."));
        return;
      }

      const etag = xhr.getResponseHeader("ETag");
      if (!etag) {
        reject(new Error("S3 did not return an ETag. Add bucket CORS to expose the ETag header."));
        return;
      }

      loadedParts.set(partNumber, blob.size);
      updateMultipartEntryProgress(entry, loadedParts);
      resolve({
        ETag: etag,
        PartNumber: partNumber
      });
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Multipart upload failed while sending a part to S3."));
    });

    xhr.addEventListener("timeout", () => {
      reject(new Error("Multipart upload timed out while sending a part to S3."));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Multipart upload was cancelled."));
    });

    xhr.send(blob);
  });
}

function updateMultipartEntryProgress(entry, loadedParts) {
  let uploadedBytes = 0;
  loadedParts.forEach((value) => {
    uploadedBytes += value;
  });
  entry.uploadedBytes = Math.min(uploadedBytes, entry.file.size);
  entry.progress = entry.file.size > 0 ? Math.min(entry.uploadedBytes / entry.file.size, 1) : 0;
  renderSelectedFiles();
}

async function completeMultipartUpload(initializedUpload, parts) {
  const response = await authFetch("/api/photography/multipart/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      key: initializedUpload.key,
      uploadId: initializedUpload.uploadId,
      parts
    })
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.details || data.message || "Failed to complete multipart upload.");
  }

  return data;
}

async function abortMultipartUpload(initializedUpload) {
  const response = await authFetch("/api/photography/multipart/abort", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      key: initializedUpload.key,
      uploadId: initializedUpload.uploadId
    })
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.details || data.message || "Failed to abort multipart upload.");
  }

  return data;
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

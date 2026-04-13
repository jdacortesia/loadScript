const dropZone = document.getElementById('dropZone');
const dataFile = document.getElementById('dataFile');
const fileName = document.getElementById('fileName');
const uploadForm = document.getElementById('uploadForm');
const terminal = document.getElementById('terminal');
const runBtn = document.getElementById('runBtn');

// Drag and Drop Logic
dropZone.onclick = () => dataFile.click();

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('active');
};

dropZone.ondragleave = () => {
    dropZone.classList.remove('active');
};

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    if (e.dataTransfer.files.length > 0) {
        dataFile.files = e.dataTransfer.files;
        updateFileName();
    }
};

dataFile.onchange = () => updateFileName();

function updateFileName() {
    if (dataFile.files.length > 0) {
        fileName.innerHTML = `Archivo seleccionado: <strong>${dataFile.files[0].name}</strong>`;
    }
}

// Log streaming logic
function appendLog(msg, type = '') {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

function startLogStream() {
    const eventSource = new EventSource('/logs');
    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.message.toLowerCase().includes('error')) {
            appendLog(data.message, 'error');
        } else if (data.message.toLowerCase().includes('finished') || data.message.toLowerCase().includes('success')) {
            appendLog(data.message, 'success');
        } else {
            appendLog(data.message);
        }
        
        if (data.message.includes('--- Process Complete ---')) {
            eventSource.close();
            runBtn.disabled = false;
            runBtn.innerText = 'Iniciar Automatización';
        }
    };
    eventSource.onerror = (err) => {
        console.error('SSE Error:', err);
        eventSource.close();
    };
}

// Form Submission
uploadForm.onsubmit = async (e) => {
    e.preventDefault();
    
    if (dataFile.files.length === 0) {
        alert('Por favor selecciona un archivo Excel o CSV.');
        return;
    }

    runBtn.disabled = true;
    runBtn.innerText = 'Ejecutando...';
    terminal.innerHTML = '';
    appendLog('Enviando configuración al servidor...', 'system');

    const formData = new FormData();
    formData.append('email', document.getElementById('email').value);
    formData.append('password', document.getElementById('password').value);
    formData.append('contacto', document.getElementById('contacto').value);
    formData.append('dryRun', document.getElementById('dryRun').checked);
    formData.append('dataFile', dataFile.files[0]);

    try {
        const response = await fetch('/run-upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (result.status === 'started') {
            startLogStream();
        } else {
            appendLog('Error al iniciar: ' + result.error, 'error');
            runBtn.disabled = false;
            runBtn.innerText = 'Iniciar Automatización';
        }
    } catch (err) {
        appendLog('Error de conexión: ' + err.message, 'error');
        runBtn.disabled = false;
        runBtn.innerText = 'Iniciar Automatización';
    }
};

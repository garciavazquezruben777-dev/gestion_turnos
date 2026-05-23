import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { 
    getFirestore, 
    collection, 
    onSnapshot, 
    doc, 
    setDoc, 
    deleteDoc,
    enableIndexedDbPersistence
} from "firebase/firestore";
import {
    getAuth,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signOut
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCm3RfRMKUFlbLLnalqyyzaUAnQl2hzhVU",
  authDomain: "gestion-turnos-30931.firebaseapp.com",
  projectId: "gestion-turnos-30931",
  storageBucket: "gestion-turnos-30931.firebasestorage.app",
  messagingSenderId: "384564408646",
  appId: "1:384564408646:web:40a1deb34358d8e7b63547",
  measurementId: "G-Y793SYC5SE"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);
const auth = getAuth(app);

// Activar persistencia local para no perder datos si recarga sin conexión o con errores
enableIndexedDbPersistence(db).catch((err) => {
    console.warn("Persistencia local no disponible:", err);
});

// State
let workers = [];
let leaves = {};
let currentDate = new Date(); // Represents the month being viewed
let unsubscribeWorkers = null;
let unsubscribeLeaves = null;
let currentWorkerProfile = null; // To track if the user has created their worker profile

const SHIFT_CYCLE = ['M', 'M', 'T', 'T', 'N', 'N', 'S', 'L', 'L', 'L', 'L', 'L'];
const MS_PER_DAY = 1000 * 60 * 60 * 24;

const FESTIVOS_LPGC = [
    // 2024
    '2024-01-01', '2024-01-06', '2024-02-13', '2024-03-28', '2024-03-29', '2024-05-01', '2024-05-30', '2024-06-24', '2024-08-15', '2024-09-09', '2024-10-12', '2024-11-01', '2024-12-06', '2024-12-25',
    // 2025
    '2025-01-01', '2025-01-06', '2025-03-04', '2025-04-17', '2025-04-18', '2025-05-01', '2025-05-30', '2025-06-24', '2025-08-15', '2025-09-08', '2025-10-12', '2025-11-01', '2025-12-06', '2025-12-08', '2025-12-25',
    // 2026
    '2026-01-01', '2026-01-06', '2026-02-17', '2026-04-02', '2026-04-03', '2026-05-01', '2026-05-30', '2026-06-24', '2026-08-15', '2026-09-08', '2026-10-12', '2026-11-01', '2026-12-06', '2026-12-08', '2026-12-25',
    // 2027
    '2027-01-01', '2027-01-06', '2027-02-09', '2027-03-25', '2027-03-26', '2027-05-01', '2027-05-30', '2027-06-24', '2027-08-16', '2027-09-08', '2027-10-12', '2027-11-01', '2027-12-06', '2027-12-08', '2027-12-25'
];

function isHabil(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const day = date.getDay();
    if (day === 0 || day === 6) return false; // Fines de semana no son hábiles
    if (FESTIVOS_LPGC.includes(dateStr)) return false; // Festivos no son hábiles
    return true;
}

function calculateAnnualUsage(workerId, year) {
    let usedV = 0, usedAP = 0, usedDC = 0;
    for (const key in leaves) {
        if (key.startsWith(workerId + '_' + year)) {
            const dateStr = key.split('_')[1];
            const type = leaves[key].type;
            if (type === 'V') {
                if (isHabil(dateStr)) usedV++;
            } else if (type === 'AP') {
                usedAP++;
            } else if (type === 'DC') {
                usedDC++;
            }
        }
    }
    return { usedV, usedAP, usedDC };
}

// Time helpers
function calculateMinutesDifference(shift, actualTimeStr, isExtra) {
    if (!actualTimeStr || !shift) return 0;
    
    const [aH, aM] = actualTimeStr.split(':').map(Number);
    let actualMins = aH * 60 + aM;
    
    let endMins = 0;
    if (shift === 'M') endMins = 14 * 60;
    else if (shift === 'T') endMins = 22 * 60;
    else if (shift === 'N') endMins = 6 * 60;
    else return 0;
    
    if (shift === 'N') {
        if (actualMins > 12 * 60) actualMins -= 24 * 60;
    } else if (shift === 'T') {
        if (actualMins < 12 * 60 && isExtra) actualMins += 24 * 60;
    }
    
    if (isExtra) {
        return Math.max(0, actualMins - endMins);
    } else {
        return Math.max(0, endMins - actualMins);
    }
}

function getActualTimeStr(shift, diffMinutes, isExtra) {
    if (!shift || !diffMinutes) return "";
    
    let endMins = 0;
    if (shift === 'M') endMins = 14 * 60;
    else if (shift === 'T') endMins = 22 * 60;
    else if (shift === 'N') endMins = 6 * 60;
    else return "";
    
    let actualMins = isExtra ? endMins + diffMinutes : endMins - diffMinutes;
    
    while (actualMins < 0) actualMins += 24 * 60;
    actualMins = actualMins % (24 * 60);
    
    const h = Math.floor(actualMins / 60);
    const m = actualMins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// DOM Elements
const calendarHeader = document.getElementById('calendar-header');
const calendarBody = document.getElementById('calendar-body');
const workerList = document.getElementById('worker-list');
const currentMonthDisplay = document.getElementById('current-month-display');

// Init
function init() {
    renderWorkerList();
    renderCalendar();

    // Listen to workers
    unsubscribeWorkers = onSnapshot(collection(db, "workers"), (snapshot) => {
        workers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // Comprobar si el usuario actual tiene perfil
        const user = auth.currentUser;
        if (user) {
            currentWorkerProfile = workers.find(w => w.uid === user.uid);
            // Si acaba de registrarse y no tiene perfil, le forzamos a crearlo (abrir modal)
            if (!currentWorkerProfile && !document.getElementById('worker-modal').classList.contains('active')) {
                openWorkerModal();
            }
        }
        
        renderWorkerList();
        renderCalendar();
        if (document.getElementById('view-stats').classList.contains('active')) {
            renderStats();
        }
    }, (error) => {
        console.error("Error al cargar funcionarios:", error);
    });

    // Listen to leaves
    unsubscribeLeaves = onSnapshot(collection(db, "leaves"), (snapshot) => {
        leaves = {};
        snapshot.docs.forEach(d => {
            leaves[d.id] = d.data();
        });
        renderWorkerList();
        renderCalendar();
        if (document.getElementById('view-stats').classList.contains('active')) {
            renderStats();
        }
    }, (error) => {
        console.error("Error al cargar ausencias:", error);
    });
}

function stopListeners() {
    if (unsubscribeWorkers) unsubscribeWorkers();
    if (unsubscribeLeaves) unsubscribeLeaves();
    workers = [];
    leaves = {};
    currentWorkerProfile = null;
}

// Logic
function getShiftForDate(cycleStartDateStr, targetDate) {
    const startDate = new Date(cycleStartDateStr + 'T00:00:00'); // Local time zone start
    const target = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    
    // Calculate difference in days
    const diffTime = target - start;
    const diffDays = Math.floor(diffTime / MS_PER_DAY);
    
    if (diffDays < 0) return null; // Before they started

    const cycleIndex = diffDays % 12;
    return SHIFT_CYCLE[cycleIndex];
}

function getLeaveForDate(workerId, dateStr) {
    return leaves[`${workerId}_${dateStr}`];
}

// Rendering
function calculateBalance(workerId) {
    let balance = 0;
    for (const key in leaves) {
        if (key.startsWith(workerId + '_')) {
            const data = leaves[key];
            if (data.extraMinutes) balance += data.extraMinutes;
            if (data.minusMinutes) balance -= data.minusMinutes;
        }
    }
    return balance;
}

function renderWorkerList() {
    workerList.innerHTML = '';
    const viewYear = currentDate.getFullYear().toString();
    const currentUser = auth.currentUser;
    
    workers.forEach(w => {
        const balance = calculateBalance(w.id);
        const balanceStr = balance >= 0 ? `+${balance}m` : `${balance}m`;
        const balanceColor = balance >= 0 ? 'var(--shift-l)' : 'var(--absence)';
        
        const isOwner = currentUser && w.uid === currentUser.uid;
        
        const li = document.createElement('li');
        li.className = 'worker-item';
        li.innerHTML = `
            <span style="display:flex; flex-direction:column;">
                ${w.name} ${isOwner ? '<small style="color:var(--shift-l)">(Tú)</small>' : ''}
                <small style="color: ${balanceColor}; font-size: 11px; margin-top: 2px;">Saldo: ${balanceStr}</small>
            </span>
            <div>
                <button class="btn-icon" onclick="openInfoModal('${w.id}', '${viewYear}')" title="Resumen Anual"><i class="fa-solid fa-list-check" style="font-size:12px;"></i></button>
                ${isOwner ? `<button class="btn-icon" onclick="deleteWorker('${w.id}')" title="Eliminar"><i class="fa-solid fa-trash" style="font-size:12px;"></i></button>` : ''}
            </div>
        `;
        workerList.appendChild(li);
    });
}

function renderCalendar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    currentMonthDisplay.textContent = `${monthNames[month]} ${year}`;
    
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    // Update grid templates
    calendarHeader.style.gridTemplateColumns = `200px repeat(${daysInMonth}, minmax(40px, 1fr))`;
    
    // Render Header
    calendarHeader.innerHTML = '<div class="worker-name-cell" style="border-right: 1px solid var(--border); font-weight: bold; justify-content: center; border-top-left-radius: 16px;">Funcionarios</div>';
    
    const dayNames = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month, d);
        const dayOfWeek = date.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        
        const headerDiv = document.createElement('div');
        headerDiv.className = `day-header ${isWeekend ? 'weekend' : ''}`;
        headerDiv.innerHTML = `<span>${dayNames[dayOfWeek]}</span><strong>${d}</strong>`;
        calendarHeader.appendChild(headerDiv);
    }
    
    // Render Body
    calendarBody.innerHTML = '';
    
    if (workers.length === 0) {
        calendarBody.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-secondary);">No hay funcionarios. Añade uno para ver el cuadrante.</div>';
        return;
    }

    workers.forEach(worker => {
        const row = document.createElement('div');
        row.className = 'worker-row';
        row.style.gridTemplateColumns = `200px repeat(${daysInMonth}, minmax(40px, 1fr))`;
        
        const nameCell = document.createElement('div');
        nameCell.className = 'worker-name-cell';
        
        const isOwner = auth.currentUser && worker.uid === auth.currentUser.uid;
        
        const balances = worker.balances || {};
        if (!balances[year.toString()]) {
            const warningBtn = isOwner ? `<button class="btn-icon" style="color: var(--shift-t); padding: 4px;" onclick="openBalanceModal('${worker.id}', '${year}')" title="Configurar Año ${year}"><i class="fa-solid fa-triangle-exclamation"></i></button>` : '<i class="fa-solid fa-triangle-exclamation" style="color:var(--text-secondary); font-size:12px; margin-left:4px;" title="Aún no ha configurado este año"></i>';
            nameCell.innerHTML = `<span>${worker.name}</span> ${warningBtn}`;
        } else {
            nameCell.textContent = worker.name;
        }
        
        row.appendChild(nameCell);
        
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, month, d);
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            
            const shift = getShiftForDate(worker.cycleStartDate, date);
            const leave = getLeaveForDate(worker.id, dateStr);
            
            const cell = document.createElement('div');
            cell.className = `day-cell ${isWeekend ? 'weekend' : ''}`;
            
            if (isOwner) {
                cell.onclick = () => openLeaveModal(worker, date, dateStr, shift, leave);
            } else {
                cell.style.cursor = 'default';
            }
            
            let extraMinsTag = '';
            if (leave && leave.extraMinutes && leave.extraMinutes > 0) {
                extraMinsTag = `<div class="extra-mins-tag">+${leave.extraMinutes}m</div>`;
            }
            
            let minusMinsTag = '';
            if (leave && leave.minusMinutes && leave.minusMinutes > 0) {
                minusMinsTag = `<div class="minus-mins-tag">-${leave.minusMinutes}m</div>`;
            }
            
            const tags = extraMinsTag + minusMinsTag;
            
            if (leave && leave.type) {
                // If there's a leave
                if (leave.type === 'J' && leave.hours < 8 && shift) {
                    // Partial leave, show shift but mark it
                    cell.innerHTML = `
                        <div class="badge shift-${shift.toLowerCase()}">
                            ${shift}
                            <div class="badge absence-partial" style="position:absolute; width:16px; height:16px; font-size:10px; top:-5px; right:-5px; box-shadow:none;">J</div>
                        </div>
                        <span class="hours-tag">-${leave.hours}h</span>
                        ${tags}
                    `;
                } else {
                    // Full leave
                    cell.innerHTML = `<div class="badge absence">${leave.type}</div>${tags}`;
                }
            } else if (shift) {
                // Normal shift
                cell.innerHTML = `<div class="badge shift-${shift.toLowerCase()}">${shift}</div>${tags}`;
            } else if (tags) {
                cell.innerHTML = `${tags}`;
            }
            
            row.appendChild(cell);
        }
        
        calendarBody.appendChild(row);
    });
}

// Navigation
function prevMonth() {
    currentDate.setMonth(currentDate.getMonth() - 1);
    renderCalendar();
}

function nextMonth() {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderCalendar();
}

function goToToday() {
    currentDate = new Date();
    renderCalendar();
}

// Worker Modal
function openWorkerModal() {
    // Si el usuario ya tiene un perfil, no le dejamos crear otro para simplificar
    if (currentWorkerProfile) {
        alert("Ya has creado tu perfil de funcionario. No puedes crear otro.");
        return;
    }
    document.getElementById('worker-modal').classList.add('active');
    document.getElementById('worker-name').focus();
}

function closeWorkerModal() {
    if (!currentWorkerProfile) {
        alert("Debes rellenar y guardar tus datos para poder usar la aplicación.");
        return;
    }
    document.getElementById('worker-modal').classList.remove('active');
    document.getElementById('worker-form').reset();
}

document.getElementById('worker-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('worker-name').value;
    const startDate = document.getElementById('worker-start-date').value;
    
    const currentYear = new Date().getFullYear().toString();
    const v = parseInt(document.getElementById('worker-v').value, 10);
    const ap = parseInt(document.getElementById('worker-ap').value, 10);
    const dc = parseInt(document.getElementById('worker-dc').value, 10);
    
    const newId = Date.now().toString();
    const user = auth.currentUser;
    if (!user) return;
    
    // Cerramos la ventana inmediatamente para dar sensación de rapidez
    document.getElementById('worker-modal').classList.remove('active');
    
    try {
        await setDoc(doc(db, "workers", newId), {
            uid: user.uid,
            name,
            cycleStartDate: startDate,
            balances: {
                [currentYear]: { V: v, AP: ap, DC: dc }
            }
        });
        currentWorkerProfile = true; // Para que no obligue a abrir
    } catch (error) {
        alert("Error al guardar en la nube: " + error.message);
    }
});

async function deleteWorker(id) {
    if (confirm('¿Estás seguro de que quieres eliminar a este funcionario?')) {
        await deleteDoc(doc(db, "workers", id));
        
        // Also delete all their leaves (optional, but good practice). 
        // In a real prod environment we'd do a batch, but for now it's okay.
        for (const key in leaves) {
            if (key.startsWith(id + '_')) {
                deleteDoc(doc(db, "leaves", key));
            }
        }
    }
}

// Leave Modal
// Variables globales para la previsualización en vivo
let currentLeaveModalState = {
    workerId: null,
    year: null,
    baseLeftV: 0,
    baseLeftAP: 0,
    baseLeftDC: 0,
    originalType: null,
    isHabil: false
};

function updateLeaveModalPreview() {
    const info = document.getElementById('leave-modal-info');
    if (!currentLeaveModalState.year) return;
    
    const newType = document.getElementById('leave-type').value;
    let previewV = currentLeaveModalState.baseLeftV;
    let previewAP = currentLeaveModalState.baseLeftAP;
    let previewDC = currentLeaveModalState.baseLeftDC;
    
    // Si el turno original era una de estas, se la devolvemos temporalmente para el cálculo
    if (currentLeaveModalState.originalType === 'V' && currentLeaveModalState.isHabil) previewV++;
    if (currentLeaveModalState.originalType === 'AP') previewAP++;
    if (currentLeaveModalState.originalType === 'DC') previewDC++;
    
    // Si la nueva selección es una de estas, se la restamos
    if (newType === 'V' && currentLeaveModalState.isHabil) previewV--;
    if (newType === 'AP') previewAP--;
    if (newType === 'DC') previewDC--;
    
    const worker = workers.find(w => w.id === currentLeaveModalState.workerId);
    
    // Si el resultado es negativo, lo ponemos en rojo
    const vColor = previewV < 0 ? 'var(--absence)' : 'var(--shift-l)';
    const apColor = previewAP < 0 ? 'var(--absence)' : 'var(--shift-l)';
    const dcColor = previewDC < 0 ? 'var(--absence)' : 'var(--shift-l)';
    
    const balanceText = `<br><span style="font-size:13px; display:inline-block; margin-top:6px;"><strong>Quedan en ${currentLeaveModalState.year}:</strong> <span style="color:${vColor}">${previewV} V</span> | <span style="color:${apColor}">${previewAP} AP</span> | <span style="color:${dcColor}">${previewDC} DC</span></span>`;
    
    info.innerHTML = `<strong>Funcionario:</strong> ${worker.name}<br><strong>Día:</strong> ${currentLeaveModalState.dateStr}<br><strong>Turno original:</strong> ${currentLeaveModalState.shift || 'Ninguno'}${balanceText}`;
}

function openLeaveModal(worker, dateObj, dateStr, shift, currentLeave) {
    const modal = document.getElementById('leave-modal');
    
    const year = dateStr.substring(0, 4);
    
    currentLeaveModalState = {
        workerId: worker.id,
        year: null, // Lo ponemos en null por si no hay balances
        originalType: currentLeave ? currentLeave.type : null,
        isHabil: isHabil(dateStr),
        dateStr: dateStr,
        shift: shift
    };
    
    const balances = worker.balances || {};
    if (balances[year]) {
        const bal = balances[year];
        const usage = calculateAnnualUsage(worker.id, year);
        currentLeaveModalState.year = year;
        currentLeaveModalState.baseLeftV = bal.V - usage.usedV;
        currentLeaveModalState.baseLeftAP = bal.AP - usage.usedAP;
        currentLeaveModalState.baseLeftDC = bal.DC - usage.usedDC;
    }
    
    document.getElementById('leave-worker-id').value = worker.id;
    document.getElementById('leave-date').value = dateStr;
    document.getElementById('leave-shift').value = shift || "";
    
    if (currentLeave) {
        document.getElementById('leave-type').value = currentLeave.type || "";
        document.getElementById('leave-hours').value = currentLeave.hours || 8;
        document.getElementById('extra-time').value = getActualTimeStr(shift, currentLeave.extraMinutes, true);
        document.getElementById('minus-time').value = getActualTimeStr(shift, currentLeave.minusMinutes, false);
    } else {
        document.getElementById('leave-type').value = "";
        document.getElementById('leave-hours').value = 8;
        document.getElementById('extra-time').value = "";
        document.getElementById('minus-time').value = "";
    }
    
    updateLeaveModalPreview();
    toggleHoursField();
    modal.classList.add('active');
}

function closeLeaveModal() {
    document.getElementById('leave-modal').classList.remove('active');
    document.getElementById('leave-form').reset();
}

function toggleHoursField() {
    const type = document.getElementById('leave-type').value;
    const hoursGroup = document.getElementById('hours-group');
    if (type === 'J') {
        hoursGroup.style.display = 'flex';
    } else {
        hoursGroup.style.display = 'none';
    }
    updateLeaveModalPreview();
}

document.getElementById('leave-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const workerId = document.getElementById('leave-worker-id').value;
    const dateStr = document.getElementById('leave-date').value;
    const shift = document.getElementById('leave-shift').value;
    const type = document.getElementById('leave-type').value;
    const hours = parseInt(document.getElementById('leave-hours').value, 10);
    
    const extraTimeStr = document.getElementById('extra-time').value;
    const minusTimeStr = document.getElementById('minus-time').value;
    
    const extraMinutes = calculateMinutesDifference(shift, extraTimeStr, true);
    const minusMinutes = calculateMinutesDifference(shift, minusTimeStr, false);
    
    const key = `${workerId}_${dateStr}`;
    
    if ((type === "NONE" || type === "") && extraMinutes === 0 && minusMinutes === 0) {
        await deleteDoc(doc(db, "leaves", key));
    } else {
        await setDoc(doc(db, "leaves", key), { 
            uid: auth.currentUser.uid,
            type: type === "NONE" ? "" : type, 
            hours, 
            extraMinutes,
            minusMinutes
        });
    }
    
    closeLeaveModal();
});

// View Navigation & Stats Chart
let chartInstance = null;

function switchTab(tab) {
    document.getElementById('view-calendar').classList.remove('active');
    document.getElementById('view-stats').classList.remove('active');
    
    document.getElementById('btn-tab-calendar').style.background = 'transparent';
    document.getElementById('btn-tab-stats').style.background = 'transparent';
    
    document.getElementById(`view-${tab}`).classList.add('active');
    document.getElementById(`btn-tab-${tab}`).style.background = 'rgba(255,255,255,0.1)';
    
    if (tab === 'stats') {
        renderStats();
    }
    
    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        document.querySelector('.sidebar').classList.remove('active');
    }
}

function renderStats() {
    const ctx = document.getElementById('stats-chart').getContext('2d');
    
    const labels = [];
    const extraData = [];
    const minusData = [];
    
    workers.forEach(w => {
        labels.push(w.name);
        let extra = 0;
        let minus = 0;
        for (const key in leaves) {
            if (key.startsWith(w.id + '_')) {
                if (leaves[key].extraMinutes) extra += leaves[key].extraMinutes;
                if (leaves[key].minusMinutes) minus += leaves[key].minusMinutes;
            }
        }
        extraData.push((extra / 60).toFixed(2));
        minusData.push((minus / 60).toFixed(2));
    });
    
    if (chartInstance) {
        chartInstance.destroy();
    }
    
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Horas Trabajadas de Más (+)',
                    data: extraData,
                    backgroundColor: 'rgba(245, 158, 11, 0.7)',
                    borderColor: 'rgba(245, 158, 11, 1)',
                    borderWidth: 1
                },
                {
                    label: 'Horas Compensadas (-)',
                    data: minusData,
                    backgroundColor: 'rgba(239, 68, 68, 0.7)',
                    borderColor: 'rgba(239, 68, 68, 1)',
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Horas',
                        color: '#94a3b8'
                    },
                    ticks: { color: '#94a3b8' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                x: {
                    ticks: { color: '#94a3b8' },
                    grid: { display: false }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#f8fafc' }
                }
            }
        }
    });
}

// Sidebar logic
document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.add('active');
});

document.getElementById('sidebar-close').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('active');
});

// Global Exports
window.openBalanceModal = function(workerId, year) {
    const worker = workers.find(w => w.id === workerId);
    if (!worker) return;
    
    document.getElementById('balance-worker-id').value = workerId;
    document.getElementById('balance-year').value = year;
    document.getElementById('balance-year-display').textContent = year;
    
    const prevYear = (parseInt(year) - 1).toString();
    const infoP = document.getElementById('balance-modal-info');
    infoP.innerHTML = "";
    
    if (worker.balances && worker.balances[prevYear]) {
        const prevBal = worker.balances[prevYear];
        const prevUsage = calculateAnnualUsage(workerId, prevYear);
        const leftV = Math.max(0, prevBal.V - prevUsage.usedV);
        const leftAP = Math.max(0, prevBal.AP - prevUsage.usedAP);
        const leftDC = Math.max(0, prevBal.DC - prevUsage.usedDC);
        
        if (leftV > 0 || leftAP > 0 || leftDC > 0) {
            infoP.innerHTML = `<strong>Aviso:</strong> En ${prevYear} sobraron <strong>${leftV} Vacaciones</strong>, <strong>${leftAP} AP</strong> y <strong>${leftDC} DC</strong>.<br>Añade los que correspondan al total del nuevo año.`;
        }
    }
    
    document.getElementById('balance-v').value = 22;
    document.getElementById('balance-ap').value = 6;
    document.getElementById('balance-dc').value = 1;
    
    document.getElementById('balance-modal').classList.add('active');
};

window.closeBalanceModal = function() {
    document.getElementById('balance-modal').classList.remove('active');
};

document.getElementById('balance-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const workerId = document.getElementById('balance-worker-id').value;
    const year = document.getElementById('balance-year').value;
    const v = parseInt(document.getElementById('balance-v').value, 10);
    const ap = parseInt(document.getElementById('balance-ap').value, 10);
    const dc = parseInt(document.getElementById('balance-dc').value, 10);
    
    const worker = workers.find(w => w.id === workerId);
    if (!worker) return;
    
    const balances = worker.balances || {};
    balances[year] = { V: v, AP: ap, DC: dc };
    
    try {
        await setDoc(doc(db, "workers", workerId), { ...worker, balances });
        window.closeBalanceModal();
    } catch (error) {
        alert("Error al guardar: " + error.message);
    }
});

// Auth Logic
let isRegisterMode = false;

window.toggleAuthMode = function(e) {
    e.preventDefault();
    isRegisterMode = !isRegisterMode;
    document.getElementById('auth-title').textContent = isRegisterMode ? 'Crear Cuenta' : 'Iniciar Sesión';
    document.getElementById('auth-submit-btn').textContent = isRegisterMode ? 'Registrarse' : 'Entrar';
    document.getElementById('auth-toggle-link').textContent = isRegisterMode ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate';
    document.getElementById('auth-error').textContent = "";
};

document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const errorDiv = document.getElementById('auth-error');
    
    try {
        if (isRegisterMode) {
            await createUserWithEmailAndPassword(auth, email, password);
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (error) {
        let msg = error.message;
        if (error.code === 'auth/email-already-in-use') msg = "El email ya está registrado.";
        if (error.code === 'auth/invalid-credential') msg = "Email o contraseña incorrectos.";
        if (error.code === 'auth/weak-password') msg = "La contraseña debe tener al menos 6 caracteres.";
        errorDiv.textContent = msg;
    }
});

window.logout = function() {
    signOut(auth);
};

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-screen').classList.remove('active');
        init();
    } else {
        document.getElementById('auth-screen').classList.add('active');
        stopListeners();
    }
});

window.openInfoModal = function(workerId, year) {
    const worker = workers.find(w => w.id === workerId);
    if (!worker) return;
    
    let content = `<strong>Funcionario:</strong> ${worker.name}<br><strong>Año:</strong> ${year}<br><hr style="border:0;border-top:1px solid var(--border);margin:12px 0;">`;
    
    const balances = worker.balances || {};
    if (!balances[year]) {
        content += `<p style="color: var(--shift-t);">Los días disponibles de ${year} aún no se han configurado. Ve al calendario y pulsa en el icono de advertencia junto a su nombre para configurarlos.</p>`;
    } else {
        const bal = balances[year];
        const usage = calculateAnnualUsage(workerId, year);
        const leftV = bal.V - usage.usedV;
        const leftAP = bal.AP - usage.usedAP;
        const leftDC = bal.DC - usage.usedDC;
        
        content += `
            <div style="margin-bottom:8px;"><strong>Vacaciones (V):</strong> Gastados ${usage.usedV} de ${bal.V}. <span style="color:${leftV<0?'var(--absence)':'var(--shift-l)'}">Quedan ${leftV}</span></div>
            <div style="margin-bottom:8px;"><strong>Asuntos Particulares (AP):</strong> Gastados ${usage.usedAP} de ${bal.AP}. <span style="color:${leftAP<0?'var(--absence)':'var(--shift-l)'}">Quedan ${leftAP}</span></div>
            <div style="margin-bottom:8px;"><strong>Días de Canarias (DC):</strong> Gastados ${usage.usedDC} de ${bal.DC}. <span style="color:${leftDC<0?'var(--absence)':'var(--shift-l)'}">Quedan ${leftDC}</span></div>
        `;
    }
    
    document.getElementById('info-modal-content').innerHTML = content;
    document.getElementById('info-modal').classList.add('active');
};

window.closeInfoModal = function() {
    document.getElementById('info-modal').classList.remove('active');
};

window.deleteWorker = deleteWorker;
window.openWorkerModal = openWorkerModal;
window.closeWorkerModal = closeWorkerModal;
window.openLeaveModal = openLeaveModal;
window.closeLeaveModal = closeLeaveModal;
window.toggleHoursField = toggleHoursField;
window.prevMonth = prevMonth;
window.nextMonth = nextMonth;
window.goToToday = goToToday;
window.switchTab = switchTab;

window.logout = window.logout;
window.toggleAuthMode = window.toggleAuthMode;

// Note: init() is now called by onAuthStateChanged

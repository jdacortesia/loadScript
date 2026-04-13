const XLSX = require('xlsx');
const fs = require('fs');

const data = [
  ["fecha_recogida", "fecha_entrega", "origen", "destino", "tipo_unidad", "tipo_remolque", "producto", "negociar", "valor_flete", "contacto", "observaciones"],
  ["10/04/2026", "12/04/2026", "Mexico City", "Monterrey", "Sencillo", "Caja Seca", "Electrónicos", "Sí", 15000, "Juan Perez", "Carga frágil"],
  ["11/04/2026", "13/04/2026", "Guadalajara", "Queretaro", "Full", "Plataforma", "Acero", "No", 22000, "Maria Lopez", "Urgente"]
];

const ws = XLSX.utils.aoa_to_sheet(data);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Ofertas");

XLSX.writeFile(wb, 'ofertas_template.xlsx');
console.log('Excel template created: ofertas_template.xlsx');

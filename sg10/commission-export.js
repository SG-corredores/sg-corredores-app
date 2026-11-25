import { esc } from './common.js';

function spreadsheetCell(cell) {
  const raw = cell.dataset.amount;
  const type = raw !== undefined && /^-?\d+(\.\d+)?$/.test(raw) ? 'Number' : 'String';
  return '<Cell><Data ss:Type="' + type + '">' + esc(type === 'Number' ? raw : cell.textContent) + '</Data></Cell>';
}

function spreadsheetFile(paper) {
  const rows = [...paper.querySelectorAll('tr')].map(row => [...row.cells].map(spreadsheetCell).join(''));
  const textRow = value => '<Cell><Data ss:Type="String">' + esc(value) + '</Data></Cell>';
  rows.unshift(...[...paper.querySelectorAll('.sgComHead strong, .sgComHead h3, .sgComHead b')]
    .map(element => textRow(element.textContent)));
  rows.push(...[...paper.querySelectorAll('.sgComTotals b')].map(element => textRow(element.textContent)));
  const content = '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>'
    + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
    + '<Worksheet ss:Name="Relación de compras"><Table>' + rows.map(row => '<Row>' + row + '</Row>').join('')
    + '</Table></Worksheet></Workbook>';
  return new File([content],'sg-relacion-compras-' + paper.dataset.date + '.xml',{type:'application/vnd.ms-excel'});
}

export function exportCommission(index) {
  const paper = document.getElementById('sgComPaper' + index);
  if (!paper) return;
  const file = spreadsheetFile(paper);
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),30_000);
}

export async function shareCommission(index) {
  const paper = document.getElementById('sgComPaper' + index);
  if (!paper) return;
  const file = spreadsheetFile(paper);
  if (!navigator.canShare?.({files:[file]})) {
    exportCommission(index);
    return;
  }
  try { await navigator.share({files:[file],title:'SG Corredores · Relación de compras'}); }
  catch (error) { if (error.name !== 'AbortError') throw error; }
}

import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';

export const IMPORT_TEMPLATE_FILE_NAME = '需求导入模板.xlsx';
export const IMPORT_TEMPLATE_SHEET_NAME = '在线需求导入';
const headers = ['店铺', '渠道', '国家', '目的FC', 'FBA货件号', '参考数量', '来源填写时间', '子批次名称', '备注', '仓库地址', '货件创建时间', '元数据来源', '查询时间'];
const fixedTime = new Date('2000-01-01T00:00:00.000Z');
const bodyFont: Partial<ExcelJS.Font> = { name: 'Arial', size: 10, color: { argb: 'FF20251D' } };

/** Uses the existing online-v1 map so uploaded files retain all supported metadata. */
export async function buildImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SCM Automation'; workbook.created = fixedTime; workbook.modified = fixedTime;
  workbook.title = '需求导入模板'; workbook.subject = '货件级需求输入';
  const sheet = workbook.addWorksheet(IMPORT_TEMPLATE_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }], properties: { defaultRowHeight: 24 },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1', printArea: 'A1:K21' },
  });
  sheet.columns = [24, 14, 14, 16, 25, 14, 25, 24, 40, 55, 25, 20, 25].map((width) => ({ width }));
  sheet.addRow(headers);
  sheet.getRow(1).height = 32;
  sheet.getRow(1).eachCell((cell, column) => {
    cell.font = { ...bodyFont, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column === 1 || column === 5 ? 'FF526B1E' : 'FF36412F' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { right: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
  });
  // Reserve a small editable area. Blank styled cells are never sample source rows.
  for (let row = 2; row <= 101; row++) for (let column = 1; column <= 11; column++) {
    if (column === 6) continue;
    const cell = sheet.getCell(row, column);
    cell.font = bodyFont;
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    cell.numFmt = column === 7 || column === 11 ? 'yyyy-mm-dd hh:mm' : '@';
    if (column === 1 || column === 5) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8DE' } };
    cell.border = { bottom: { style: 'hair', color: { argb: 'FFE9ECE4' } } };
  }
  // Keep the legacy quantity column and reserved evidence headers for online-v1 compatibility.
  sheet.getColumn(6).hidden = true; sheet.getColumn(12).hidden = true; sheet.getColumn(13).hidden = true;
  sheet.autoFilter = { from: 'A1', to: 'K101' };

  const guide = workbook.addWorksheet('填写说明', { views: [{ showGridLines: false }], properties: { defaultRowHeight: 25 } });
  guide.columns = [{ width: 22 }, { width: 20 }, { width: 84 }];
  guide.getCell('A2').value = '需求导入模板'; guide.getCell('A2').font = { ...bodyFont, size: 14, bold: true };
  guide.getCell('A4').value = '填写方法'; guide.getCell('B4').value = '第 2 行开始';
  guide.getCell('C4').value = '每行填写 1 个 FBA；连续行属于同一票，两票之间留一个整行空白。连续空行只作一次分隔，首尾空行忽略。保留第 1 行表头与列顺序。';
  guide.getCell('A5').value = '必填项'; guide.getCell('B5').value = '店铺、FBA货件号';
  guide.getCell('C5').value = '本多列表模板保留店铺、FBA 必填要求。“仅导入需求”仍需核对来源与提交范围；“本次发货自动整理”会按空行分票并补全货件资料。';
  guide.getCell('A6').value = '仅 FBA 清单'; guide.getCell('B6').value = '独立单列表';
  guide.getCell('C6').value = '自动整理也支持另建单列 XLSX：A 列每行 1 个 FBA，表头可选“FBA”或“FBA货件号”，空行分票。同一段须为同一国家，不得重复填写 FBA。';
  guide.getCell('A7').value = '字段'; guide.getCell('B7').value = '填写要求'; guide.getCell('C7').value = '说明';
  const fields = [
    ['店铺', '必填，文本', '填写所属店铺名称，导入后确认对应店铺。'],
    ['渠道', '选填，文本', '填写领星发货单维护的运输方式，如海派、空派。“仅导入需求”保留文件原值；自动整理会查询补全，异常时需核对。不要填写物流渠道名称或平台配送类型。'],
    ['国家', '建议填写，文本', '填写目的国家，核对是否与所选店铺一致。'],
    ['目的FC', '选填，文本', '填写目的仓代码。完整地址填写在“仓库地址”列。'],
    ['FBA货件号', '必填，文本', '以 FBA 开头，仅含字母和数字。不要使用数字或公式保存货件号。'],
    ['来源填写时间', '选填，日期或日期时间', '填写原始需求记录的填写时间，用于计算打包天数。导入业务日期按系统首次接收时的上海日期确定。'],
    ['子批次名称', '选填，文本', '保留来源中的分组标签。系统不会据此自动合组。'],
    ['备注', '选填，文本', '填写需要保留的业务备注。'],
    ['仓库地址', '选填，文本', '填写完整的货件目的仓地址。'],
    ['货件创建时间', '选填，日期或日期时间', '填写平台创建货件的时间，与实际发货日期分别保留。'],
    ['元数据来源、查询时间', '系统保留，请勿填写', '这两列默认隐藏。文件中手工填写的信息按文件来源保留，查询来源需通过系统查询取得。'],
    ['隐藏兼容列', '系统保留，无需填写', 'F 列保留旧版数量字段以兼容历史文件，默认隐藏；填写新需求时无需展开或填写。'],
  ];
  for (const [index, values] of fields.entries()) guide.getRow(index + 8).values = values;
  guide.getCell('A21').value = '日期格式'; guide.getCell('B21').value = '年-月-日 时:分';
  guide.getCell('C21').value = '可在日期单元格输入日期或日期时间；仅填写日期时显示 00:00。来源中带时区的时间可保留原始文本。';
  guide.getCell('A22').value = '空白模板'; guide.getCell('B22').value = '先填写，再上传';
  guide.getCell('C22').value = '模板没有示例需求。未填写任何需求时上传会提示先填写至少一行。不要把本说明页复制到输入区。';
  guide.getCell('A23').value = '行数范围'; guide.getCell('B23').value = '最多 9999 行需求';
  guide.getCell('C23').value = '预设 100 行空白输入区，可继续追加到第 10000 行。不要合并数据单元格，不要删除表头。';
  guide.eachRow((row, rowNumber) => row.eachCell((cell) => {
    if (rowNumber !== 2) cell.font = bodyFont;
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  }));
  guide.getRow(2).height = 30;
  for (const row of [4, 5, 6, 14, 19, 21, 22, 23]) guide.getRow(row).height = 48;
  guide.getRow(7).eachCell((cell) => {
    cell.font = { ...bodyFont, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF36412F' } };
  });
  guide.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: 'A1:C23' };
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  return Buffer.from(zipSync(unzipSync(bytes), { mtime: fixedTime }));
}

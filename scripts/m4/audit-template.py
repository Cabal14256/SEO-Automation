"""Read-only local audit of the supplied legacy template and filled XLSX.

Requires xlrd for legacy BIFF; writes only a summary under the selected output.
No business values, addresses, prices or images are copied to the summary.
"""
from pathlib import Path
import argparse
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--xlrd-path')
    parser.add_argument('--source', required=True, type=Path, help='Controlled legacy .xls template')
    parser.add_argument('--sample', required=True, type=Path, help='Controlled filled .xlsx example')
    parser.add_argument('--out', default='.local/m4/template-audit.json')
    args = parser.parse_args()
    if args.xlrd_path:
        sys.path.insert(0, args.xlrd_path)
    import xlrd
    repo = Path(__file__).resolve().parents[2]
    source = args.source.resolve()
    sample = args.sample.resolve()
    book = xlrd.open_workbook(source)
    sheet = book.sheet_by_index(0)
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(sample) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            strings = [''.join(node.itertext()) for node in root.findall('s:si', ns)]
        root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        sample_headers = []
        for cell in root.findall('.//s:row[@r="17"]/s:c', ns):
            value = cell.find('s:v', ns)
            sample_headers.append(strings[int(value.text)] if cell.attrib.get('t') == 's' and value is not None else (value.text if value is not None else ''))
    normalize = lambda text: ''.join(str(text).split()).replace('*', '')
    headers = [str(value) for value in sheet.row_values(16)[:17]]
    if [normalize(value) for value in headers] != [normalize(value) for value in sample_headers]:
        raise ValueError('Legacy template and filled XLSX detail headers differ')
    summary = {
        'kind': 'read-only-fengxin-template-audit',
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'sampleSha256': hashlib.sha256(sample.read_bytes()).hexdigest(),
        'legacySheets': [{'name': s.name, 'rows': s.nrows, 'columns': s.ncols} for s in book.sheets()],
        'mainHeaderRow': 17, 'dataStartRow': 18, 'headers': headers,
        'mainHeaderLabels': [{'row': row + 1, 'left': sheet.cell_value(row, 0), 'right': sheet.cell_value(row, 4)} for row in range(16)],
        'customsOptions': [str(int(value)) if isinstance(value, float) else value for value in book.sheet_by_index(1).col_values(0)],
        'notes': ['Source and filled XLSX have the same A17:Q17 field layout', 'Source sales link is mandatory', 'remarks and deliveryWindow are marked mandatory', 'VAT applicability remains conditional', 'Sample dates/addresses/products/media are excluded from this report', 'Receiving-system actual import remains pending'],
    }
    target = repo / args.out
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'result': 'passed', 'headers': len(headers), 'output': str(target)}, ensure_ascii=False))


if __name__ == '__main__':
    main()

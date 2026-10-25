"""Read-only T05 diagnostics, not the production M1 spreadsheet parser."""
import argparse
import csv
import hashlib
import json
import posixpath
import sys
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
MAX_PART = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_ENTRIES = 10_000
MAX_ROWS = 250_000
MAX_CELLS = 2_000_000


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def read_xml(archive, name):
    data = archive.read(name)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('XML_DTD_NOT_SUPPORTED')
    return ET.fromstring(data)


def column_number(address):
    letters = ''.join(c for c in address if c.isalpha())
    if not letters or not letters.isascii():
        raise ValueError('INVALID_CELL_ADDRESS')
    result = 0
    for character in letters.upper():
        result = result * 26 + ord(character) - 64
    if result > 16_384:
        raise ValueError('INVALID_CELL_ADDRESS')
    return result


def column_profile(number):
    return {'column': number, 'header': None, 'presentCells': 0, 'nonemptyValues': 0,
            'valueTypes': Counter(), 'numberFormatIds': Counter(),
            'formulaCells': 0, 'formulasWithoutCachedValue': 0, 'formulaCacheStates': Counter()}


def xlsx_profile(path, header_row):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES or sum(i.file_size for i in entries) > MAX_TOTAL:
            raise ValueError('ARCHIVE_LIMIT_EXCEEDED')
        names = set()
        for item in entries:
            name = item.filename
            if name in names or name.startswith(('/', '\\')) or '\\' in name or ':' in name or '..' in name.split('/'):
                raise ValueError('UNSAFE_ARCHIVE_PATH')
            names.add(name)
            if item.file_size > MAX_PART:
                raise ValueError('ARCHIVE_LIMIT_EXCEEDED')
        workbook = read_xml(archive, 'xl/workbook.xml')
        relationships = read_xml(archive, 'xl/_rels/workbook.xml.rels')
        targets = {}
        for relation in relationships:
            if relation.get('TargetMode') == 'External':
                continue
            target = relation.get('Target', '')
            if '\\' in target or '..' in target.split('/') or ':' in target:
                raise ValueError('UNSAFE_RELATIONSHIP_TARGET')
            name = target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target)
            targets[relation.get('Id')] = name
        shared = []
        if 'xl/sharedStrings.xml' in names:
            for entry in read_xml(archive, 'xl/sharedStrings.xml').findall(MAIN + 'si'):
                shared.append(''.join(n.text or '' for n in entry.iter(MAIN + 't')))
        formats, style_ids = {}, [0]
        if 'xl/styles.xml' in names:
            styles = read_xml(archive, 'xl/styles.xml')
            for entry in styles.findall(MAIN + 'numFmts/' + MAIN + 'numFmt'):
                formats[entry.get('numFmtId')] = entry.get('formatCode')
            style_ids = [int(e.get('numFmtId', '0')) for e in styles.findall(MAIN + 'cellXfs/' + MAIN + 'xf')]
        sheets = []
        for source_sheet in workbook.findall(MAIN + 'sheets/' + MAIN + 'sheet'):
            target = targets.get(source_sheet.get(REL))
            if not target or target not in names:
                raise ValueError('MISSING_WORKSHEET')
            xml = read_xml(archive, target)
            sheet = {'name': source_sheet.get('name'), 'state': source_sheet.get('state', 'visible'),
                     'dimension': None, 'headerRow': header_row, 'nonemptyDataRows': 0,
                     'hiddenRows': 0, 'mergedRanges': [], 'hiddenColumns': [], 'columns': []}
            dimension = xml.find(MAIN + 'dimension')
            if dimension is not None:
                sheet['dimension'] = dimension.get('ref')
            sheet['mergedRanges'] = [n.get('ref') for n in xml.findall(MAIN + 'mergeCells/' + MAIN + 'mergeCell')]
            sheet['hiddenColumns'] = [{'min': n.get('min'), 'max': n.get('max')}
                                      for n in xml.findall(MAIN + 'cols/' + MAIN + 'col') if n.get('hidden') in ('1', 'true')]
            columns, cells_seen = {}, 0
            for row_index, row in enumerate(xml.findall(MAIN + 'sheetData/' + MAIN + 'row'), 1):
                if row_index > MAX_ROWS:
                    raise ValueError('WORKSHEET_LIMIT_EXCEEDED')
                row_number = int(row.get('r', row_index))
                sheet['hiddenRows'] += int(row.get('hidden') in ('1', 'true'))
                nonempty = False
                for cell in row.findall(MAIN + 'c'):
                    cells_seen += 1
                    if cells_seen > MAX_CELLS:
                        raise ValueError('WORKSHEET_LIMIT_EXCEEDED')
                    number = column_number(cell.get('r', ''))
                    profile = columns.setdefault(number, column_profile(number))
                    kind = cell.get('t', 'n')
                    value = cell.find(MAIN + 'v')
                    text = None if value is None else value.text
                    if kind == 'inlineStr':
                        text = ''.join(n.text or '' for n in cell.findall(MAIN + 'is//' + MAIN + 't'))
                    elif kind == 's' and text is not None:
                        try:
                            index = int(text)
                            if index < 0:
                                raise ValueError
                            text = shared[index]
                        except (ValueError, IndexError) as exc:
                            raise ValueError('INVALID_SHARED_STRING') from exc
                    formula = cell.find(MAIN + 'f') is not None
                    has_value = text is not None and text != ''
                    if row_number == header_row:
                        # Header text remains literal, without converting numeric identifiers.
                        profile['header'] = text
                    if row_number <= header_row:
                        continue
                    profile['presentCells'] += 1
                    profile['nonemptyValues'] += int(has_value)
                    profile['valueTypes'][kind if has_value else 'blank'] += 1
                    style = int(cell.get('s', '0'))
                    if style < 0 or style >= len(style_ids):
                        raise ValueError('INVALID_STYLE_INDEX')
                    profile['numberFormatIds'][str(style_ids[style])] += 1
                    profile['formulaCells'] += int(formula)
                    profile['formulasWithoutCachedValue'] += int(formula and value is None)
                    if formula:
                        profile['formulaCacheStates']['absent' if value is None else 'present' if has_value else 'empty'] += 1
                    nonempty |= has_value or formula
                if row_number > header_row and nonempty:
                    sheet['nonemptyDataRows'] += 1
            sheet['columns'] = [columns[n] for n in sorted(columns)]
            sheets.append(sheet)
        if not sheets:
            raise ValueError('MISSING_WORKSHEET')
        properties = workbook.find(MAIN + 'workbookPr')
        return {'format': 'xlsx', 'dateSystem': '1904' if properties is not None and properties.get('date1904') in ('1', 'true') else '1900',
                'customNumberFormats': formats, 'sheets': sheets}


def delimited_profile(path, header_row, encoding):
    columns = {}
    count = 0
    with path.open('r', encoding=encoding, newline='') as stream:
        for number, row in enumerate(csv.reader(stream, delimiter='\t' if path.suffix.lower() == '.tsv' else ','), 1):
            if number > MAX_ROWS:
                raise ValueError('WORKSHEET_LIMIT_EXCEEDED')
            if len(row) > 16_384:
                raise ValueError('WORKSHEET_LIMIT_EXCEEDED')
            for index, value in enumerate(row, 1):
                item = columns.setdefault(index, column_profile(index))
                if number == header_row:
                    item['header'] = value
                elif number > header_row:
                    item['presentCells'] += 1
                    item['nonemptyValues'] += int(value != '')
                    item['valueTypes']['text' if value != '' else 'blank'] += 1
            if number > header_row and any(value != '' for value in row):
                count += 1
    return {'format': path.suffix.lower()[1:], 'encoding': encoding,
            'sheets': [{'name': None, 'headerRow': header_row, 'nonemptyDataRows': count,
                        'columns': [columns[n] for n in sorted(columns)]}]}


def inspect_source(path, header_row=1, encoding='utf-8-sig'):
    path = Path(path).resolve(strict=True)
    if header_row < 1 or not path.is_file():
        raise ValueError('INVALID_INPUT')
    if path.stat().st_size > MAX_TOTAL:
        raise ValueError('FILE_LIMIT_EXCEEDED')
    before = digest(path)
    suffix = path.suffix.lower()
    if suffix == '.xlsx':
        profile = xlsx_profile(path, header_row)
    elif suffix in ('.csv', '.tsv'):
        profile = delimited_profile(path, header_row, encoding)
    else:
        raise ValueError('UNSUPPORTED_FORMAT_USE_ORIGINAL_XLSX_CSV_OR_TSV')
    if digest(path) != before:
        raise ValueError('SOURCE_CHANGED_DURING_INSPECTION')
    return {'source': str(path), 'sha256': before, 'bytes': path.stat().st_size,
            'sourceProvenance': 'unconfirmed', **profile}


def run(sources, output, header_row=1, encoding='utf-8-sig'):
    paths = [Path(source).resolve(strict=True) for source in sources]
    output = Path(output).resolve()
    if output in paths or output.exists():
        raise ValueError('OUTPUT_EXISTS_OR_OVERWRITES_SOURCE')
    profiles = [inspect_source(path, header_row, encoding) for path in paths]
    result = {'kind': 'readonly-input-profile', 'checkedAt': datetime.now(timezone.utc).isoformat(),
              'businessTimezone': 'Asia/Shanghai', 'sourcePairRelationship': 'unconfirmed',
              'businessAcceptance': 'not-performed', 'sources': profiles}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', action='append', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--header-row', type=int, default=1)
    parser.add_argument('--encoding', default='utf-8-sig')
    args = parser.parse_args()
    try:
        report = run(args.source, args.out, args.header_row, args.encoding)
    except (OSError, ValueError, LookupError, ET.ParseError, zipfile.BadZipFile, KeyError, csv.Error, RuntimeError) as error:
        # Body cells, malformed ZIP metadata and account details never go to logs.
        safe_codes = {'UNSUPPORTED_FORMAT_USE_ORIGINAL_XLSX_CSV_OR_TSV', 'OUTPUT_EXISTS_OR_OVERWRITES_SOURCE',
                      'ARCHIVE_LIMIT_EXCEEDED', 'WORKSHEET_LIMIT_EXCEEDED', 'FILE_LIMIT_EXCEEDED',
                      'UNSAFE_ARCHIVE_PATH', 'UNSAFE_RELATIONSHIP_TARGET', 'XML_DTD_NOT_SUPPORTED',
                      'SOURCE_CHANGED_DURING_INSPECTION', 'INVALID_INPUT', 'MISSING_WORKSHEET',
                      'INVALID_SHARED_STRING', 'INVALID_STYLE_INDEX', 'INVALID_CELL_ADDRESS'}
        code = str(error) if str(error) in safe_codes else 'INVALID_OR_UNSUPPORTED_INPUT'
        print(f'Input inspection failed ({code}).', file=sys.stderr)
        return 1
    print(f"Read-only inspection complete: {len(report['sources'])} files. Provenance and business rules remain unconfirmed.")
    return 0


if __name__ == '__main__':
    sys.exit(main())

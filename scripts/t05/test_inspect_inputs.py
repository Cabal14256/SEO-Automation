"""Synthetic ZIP/CSV fixtures only. These do not constitute business acceptance."""
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import inspect_inputs as tool

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'


def fixture(path, sheet_xml=None, extra=None, date1904=False, target='worksheets/sheet1.xml'):
    sheet_xml = sheet_xml or f'''<worksheet xmlns="{NS}"><dimension ref="A1:F3"/>
      <cols><col min="2" max="2" hidden="1"/></cols><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Quantity</t></is></c></row>
      <row r="2" hidden="1"><c r="A2"><v>0</v></c><c r="B2"/><c r="C2" t="s"><v>1</v></c>
      <c r="D2"><f>3+4</f><v>7</v></c><c r="E2"><f>1+1</f></c><c r="F2" s="1"><v>45000</v></c></row>
      <row r="3"><c r="A3" t="str"><f>IF(1,\"\",\"\")</f><v/></c></row></sheetData>
      <mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>'''
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xl/workbook.xml', f'''<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{int(date1904)}"/><sheets><sheet name="Source " state="hidden" sheetId="1" r:id="rId1"/></sheets></workbook>''')
        archive.writestr('xl/_rels/workbook.xml.rels', f'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="{target}"/></Relationships>''')
        archive.writestr('xl/sharedStrings.xml', f'''<sst xmlns="{NS}"><si><r><t>Record</t></r><r><t> ID</t></r></si><si><t>private-person-marker</t></si></sst>''')
        archive.writestr('xl/styles.xml', f'''<styleSheet xmlns="{NS}"><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>''')
        archive.writestr('xl/worksheets/sheet1.xml', sheet_xml)
        for name, data in (extra or {}).items():
            archive.writestr(name, data)


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'synthetic.xlsx'

    def tearDown(self):
        self.temp.cleanup()

    def test_zero_blank_rich_strings_formula_caches_and_metadata(self):
        fixture(self.path)
        before = self.path.read_bytes()
        report = tool.inspect_source(self.path)
        sheet = report['sheets'][0]
        columns = {c['column']: c for c in sheet['columns']}
        self.assertEqual(sheet['name'], 'Source ')
        self.assertEqual(sheet['state'], 'hidden')
        self.assertEqual(sheet['hiddenRows'], 1)
        self.assertEqual(sheet['hiddenColumns'], [{'min': '2', 'max': '2'}])
        self.assertEqual(sheet['mergedRanges'], ['A1:B1'])
        self.assertEqual(sheet['nonemptyDataRows'], 2)
        self.assertEqual(columns[1]['header'], 'Record ID')
        self.assertEqual(columns[2]['header'], 'Quantity')
        self.assertEqual(columns[1]['nonemptyValues'], 1)
        self.assertEqual(columns[1]['valueTypes']['n'], 1)
        self.assertEqual(columns[2]['valueTypes']['blank'], 1)
        self.assertEqual(columns[4]['formulaCacheStates']['present'], 1)
        self.assertEqual(columns[5]['formulaCacheStates']['absent'], 1)
        self.assertEqual(columns[1]['formulaCacheStates']['empty'], 1)
        self.assertEqual(columns[6]['numberFormatIds']['164'], 1)
        self.assertEqual(report['customNumberFormats']['164'], 'yyyy-mm-dd')
        self.assertNotIn('private-person-marker', json.dumps(report))
        self.assertEqual(self.path.read_bytes(), before)

    def test_date_system_is_preserved_without_assigning_business_dates(self):
        fixture(self.path, date1904=True)
        report = tool.inspect_source(self.path)
        self.assertEqual(report['dateSystem'], '1904')
        self.assertNotIn('businessDate', report)

    def test_output_cannot_replace_input_or_existing_reports(self):
        fixture(self.path)
        original = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'OUTPUT_EXISTS'):
            tool.run([self.path], self.path)
        output = self.root / 'report.json'
        report = tool.run([self.path], output)
        self.assertEqual(report['sourcePairRelationship'], 'unconfirmed')
        self.assertEqual(report['businessAcceptance'], 'not-performed')
        with self.assertRaisesRegex(ValueError, 'OUTPUT_EXISTS'):
            tool.run([self.path], output)
        self.assertEqual(self.path.read_bytes(), original)

    def test_archive_traversal_and_unsafe_relationship_are_rejected(self):
        fixture(self.path, extra={'../outside.xml': '<x/>'})
        with self.assertRaisesRegex(ValueError, 'UNSAFE_ARCHIVE_PATH'):
            tool.inspect_source(self.path)
        fixture(self.path, target='../secret.xml')
        with self.assertRaisesRegex(ValueError, 'UNSAFE_RELATIONSHIP'):
            tool.inspect_source(self.path)

    def test_xml_entity_payload_is_rejected(self):
        fixture(self.path, sheet_xml='<!DOCTYPE x [<!ENTITY x "private">]><x>&x;</x>')
        with self.assertRaisesRegex(ValueError, 'XML_DTD'):
            tool.inspect_source(self.path)

    def test_zip_limits_and_corrupt_archives_fail_without_output(self):
        fixture(self.path)
        with patch.object(tool, 'MAX_PART', 50):
            with self.assertRaisesRegex(ValueError, 'ARCHIVE_LIMIT'):
                tool.inspect_source(self.path)
        self.path.write_bytes(b'not an xlsx')
        output = self.root / 'not-created.json'
        with self.assertRaises(zipfile.BadZipFile):
            tool.run([self.path], output)
        self.assertFalse(output.exists())

    def test_csv_values_remain_text_and_encoding_is_explicit(self):
        source = self.root / 'synthetic.csv'
        source.write_text('记录ID,数量\n001,0\n002,\n', encoding='utf-8-sig')
        report = tool.inspect_source(source)
        columns = report['sheets'][0]['columns']
        self.assertEqual(columns[0]['valueTypes'], {'text': 2})
        self.assertEqual(columns[1]['valueTypes'], {'text': 1, 'blank': 1})
        source.write_text('记录ID,数量\n001,0\n', encoding='gb18030')
        with self.assertRaises(UnicodeDecodeError):
            tool.inspect_source(source)
        self.assertEqual(tool.inspect_source(source, encoding='gb18030')['encoding'], 'gb18030')

    def test_legacy_xls_is_not_silently_treated_as_xlsx(self):
        source = self.root / 'legacy.xls'
        source.write_bytes(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')
        with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_FORMAT'):
            tool.inspect_source(source)


if __name__ == '__main__':
    unittest.main()

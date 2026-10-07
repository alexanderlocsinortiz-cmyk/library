from pathlib import Path
from zipfile import ZipFile
from lxml import etree as E
from PIL import Image
import json

root=Path(__file__).parent
src=Path(r'C:\Users\xander\Downloads\IBA_Library_System-RESERVATION_CORRECTED.docx')
out=src.with_name('IBA_Library_System-RESERVATION_UPDATED_IMAGES.docx')
names=['login','dashboard','public_catalog','members','circulation','reservations','requests','stock_audit','reports','transactions']
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing','pic':'http://schemas.openxmlformats.org/drawingml/2006/picture'}
with ZipFile(src) as z:
    xml=E.fromstring(z.read('word/document.xml'))
    relations={r.get('Id'):'word/'+r.get('Target') for r in E.fromstring(z.read('word/_rels/document.xml.rels'))}
    updates={};checks=[]
    for i,name in enumerate(names,6):
        target=f'word/media/image{i}.png';path=root/'assets'/(name+'.png')
        assert path.exists(),path
        updates[target]=path.read_bytes()
        refs=[rid for rid,t in relations.items() if t==target]
        assert len(refs)==1
        blips=xml.xpath('.//a:blip[@r:embed="'+refs[0]+'"]',namespaces=ns)
        assert len(blips)==1
        blip=blips[0]
        picture=blip
        while picture.tag not in ('{'+ns['wp']+'}inline','{'+ns['wp']+'}anchor'):picture=picture.getparent()
        extent=picture.find('wp:extent',ns)
        oldw,oldh=int(extent.get('cx')),int(extent.get('cy'))
        w,h=Image.open(path).size
        scale=min(oldw/w,oldh/h);neww,newh=round(w*scale),round(h*scale)
        extent.set('cx',str(neww));extent.set('cy',str(newh))
        for size in picture.xpath('.//pic:spPr/a:xfrm/a:ext',namespaces=ns):
            size.set('cx',str(neww));size.set('cy',str(newh))
        for crop in picture.xpath('.//a:srcRect',namespaces=ns):crop.getparent().remove(crop)
        checks.append({'figure':i-1,'image':name,'pixels':[w,h]})
    updates['word/document.xml']=E.tostring(xml,xml_declaration=True,encoding='UTF-8',standalone=True)
    with ZipFile(out,'w') as dest:
        for item in z.infolist():dest.writestr(item,updates.get(item.filename,z.read(item.filename)))
with ZipFile(src) as a,ZipFile(out) as b:
    before=E.fromstring(a.read('word/document.xml'));after=E.fromstring(b.read('word/document.xml'))
    assert before.xpath('//w:t/text()',namespaces=ns)==after.xpath('//w:t/text()',namespaces=ns)
    for name in a.namelist():
        if name not in updates:assert a.read(name)==b.read(name),name
(root/'replacement_log.json').write_text(json.dumps(checks,indent=2))
print(out)
print('Verified: ten screenshot replacements; all text and unrelated package parts preserved.')

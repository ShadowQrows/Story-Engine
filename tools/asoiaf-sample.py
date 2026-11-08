"""Builds a Story Engine sample world for the first chapters of A Game of Thrones.
All descriptions and scene summaries are original paraphrase (no text from the book)."""
import json, os, shutil, sys
OUT = sys.argv[1]
ROOT = 'ASOIAF Sample'
base = os.path.join(OUT, ROOT)
shutil.rmtree(base, ignore_errors=True)
def w(path, text):
    full = os.path.join(base, path); os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, 'w', encoding='utf-8').write(text)
def yq(s): return json.dumps(s, ensure_ascii=False)

# ── pieces ─────────────────────────────────────────────────────────────
# id, name, type, aliases, connections [(target name, label)], themes, description
P = []
def piece(id, name, type, desc, aliases=(), conns=(), themes=()):
    P.append(dict(id=id, name=name, type=type, desc=desc, aliases=list(aliases), conns=list(conns), themes=list(themes)))

# Characters
piece('ned', 'Eddard Stark', 'character', "Lord of Winterfell and Warden of the North. Grave, dutiful and slow to smile; he carries out his own sentences, believing the man who passes judgement should swing the sword.",
      ['Ned', 'Lord Eddard', 'Lord Stark'], [('Catelyn Stark', 'Married to'), ('Robb Stark', 'Parent of'), ('Sansa Stark', 'Parent of'), ('Arya Stark', 'Parent of'), ('Bran Stark', 'Parent of'), ('Rickon Stark', 'Parent of'), ('Jon Snow', 'Parent of'), ('Benjen Stark', 'Sibling'), ('Robert Baratheon', 'Ally'), ('House Stark', 'Member of'), ('Ice', 'Owns')], ['Honour', 'Winter is coming'])
piece('cat', 'Catelyn Stark', 'character', "Lady of Winterfell, born a Tully of Riverrun. Keeps the faith of the Seven in a castle of the old gods; fiercely protective of her children and cool towards her husband's bastard.",
      ['Cat', 'Lady Catelyn', 'Catelyn Tully'], [('House Stark', 'Member of'), ('Lysa Arryn', 'Sibling')])
piece('robb', 'Robb Stark', 'character', "Ned's eldest son and heir, about fourteen. Eager to be seen as a man; close to Jon and Theon.", ['Robb'], [('House Stark', 'Member of'), ('Grey Wind', 'Owns')])
piece('jon', 'Jon Snow', 'character', "Ned's bastard son, raised at Winterfell alongside his trueborn siblings but never quite one of them. Dreams of joining his uncle on the Wall.", ['Jon', 'Snow'], [('Ghost', 'Owns'), ('Robb Stark', 'Sibling'), ('Arya Stark', 'Sibling')], ['Bastardy'])
piece('sansa', 'Sansa Stark', 'character', "Ned's elder daughter. Courteous, accomplished at needlework and full of songs about knights and queens.", ['Sansa'], [('House Stark', 'Member of'), ('Lady', 'Owns')])
piece('arya', 'Arya Stark', 'character', "Ned's younger daughter, about nine. Hates needlework and ladylike rules, loves horses and swords; her closest sibling is Jon.", ['Arya', 'Arya Underfoot'], [('House Stark', 'Member of'), ('Nymeria', 'Owns')])
piece('bran', 'Bran Stark', 'character', "Ned's second son, about seven. Climbs everything in Winterfell and wants to be a knight of the Kingsguard.", ['Bran', 'Brandon'], [('House Stark', 'Member of'), ('Summer', 'Owns')])
piece('rickon', 'Rickon Stark', 'character', "The youngest Stark, barely three.", ['Rickon'], [('House Stark', 'Member of'), ('Shaggydog', 'Owns')])
piece('theon', 'Theon Greyjoy', 'character', "Heir of the Iron Islands, raised at Winterfell as Ned's ward and hostage after his father's failed rebellion. Quick to grin and quicker to mock.", ['Theon', 'Greyjoy'], [('Eddard Stark', 'Ward of')])
piece('benjen', 'Benjen Stark', 'character', "Ned's younger brother, First Ranger of the Night's Watch. Visits Winterfell for the king's feast.", ['Benjen', 'Uncle Benjen'], [('Night\'s Watch', 'Member of')])
piece('luwin', 'Maester Luwin', 'character', "Winterfell's maester: healer, tutor and keeper of the ravens.", ['Luwin'], [('House Stark', 'Serves')])
piece('robert', 'Robert Baratheon', 'character', "King of the Seven Kingdoms, who won the throne in a rebellion alongside Ned. Once a great warrior, now heavy, loud and restless.", ['Robert', 'King Robert', 'the king'], [('Cersei Lannister', 'Married to'), ('House Baratheon', 'Member of'), ('House Targaryen', 'Enemy')])
piece('cersei', 'Cersei Lannister', 'character', "Robert's queen. Proud, guarded and contemptuous of the North.", ['Cersei', 'the queen'], [('House Lannister', 'Member of'), ('Jaime Lannister', 'Sibling'), ('Jaime Lannister', 'Lover'), ('Joffrey Baratheon', 'Parent of'), ('Myrcella Baratheon', 'Parent of'), ('Tommen Baratheon', 'Parent of')], ['Secrets'])
piece('jaime', 'Jaime Lannister', 'character', "Cersei's twin, a knight of the Kingsguard. Famous, golden and widely distrusted for killing the last king he was sworn to guard.", ['Jaime', 'the Kingslayer', 'Ser Jaime'], [('House Lannister', 'Member of'), ('Robert Baratheon', 'Serves'), ('Bran Stark', 'Attacked')], ['Secrets'])
piece('tyrion', 'Tyrion Lannister', 'character', "The queen's younger brother, a dwarf. Sharp-tongued, bookish and fond of wine; gives Jon blunt advice about being an outsider.", ['Tyrion', 'the Imp'], [('House Lannister', 'Member of'), ('Jaime Lannister', 'Sibling'), ('Cersei Lannister', 'Sibling')], ['Bastardy'])
piece('joffrey', 'Joffrey Baratheon', 'character', "The crown prince, about twelve. Handsome and spoiled; Robert proposes matching him with Sansa.", ['Joffrey', 'the prince'], [('House Baratheon', 'Member of'), ('Sansa Stark', 'Betrothed to')])
piece('myrcella', 'Myrcella Baratheon', 'character', "The royal princess, Joffrey's younger sister.", ['Myrcella'], [('House Baratheon', 'Member of')])
piece('tommen', 'Tommen Baratheon', 'character', "The youngest royal child, plump and gentle.", ['Tommen'], [('House Baratheon', 'Member of')])
piece('sandor', 'Sandor Clegane', 'character', "Joffrey's sworn shield, a huge man with a burned face.", ['The Hound', 'Sandor'], [('Joffrey Baratheon', 'Serves')])
piece('jonarryn', 'Jon Arryn', 'character', "Lord of the Eyrie and Hand of the King; foster father to both Ned and Robert. His sudden death sets the story moving.", ['Lord Arryn'], [('Lysa Arryn', 'Married to'), ('House Arryn', 'Member of'), ('Robert Baratheon', 'Serves')])
piece('lysa', 'Lysa Arryn', 'character', "Catelyn's younger sister and Jon Arryn's widow. Has fled to the Eyrie with her young son, and sends Catelyn a secret warning.", ['Lysa'], [('House Arryn', 'Member of')], ['Secrets'])
piece('dany', 'Daenerys Targaryen', 'character', "The last daughter of the dragon kings, about thirteen, living in exile across the Narrow Sea. Shy and frightened of her brother.", ['Dany', 'Daenerys', 'Princess'], [('House Targaryen', 'Member of'), ('Viserys Targaryen', 'Sibling'), ('Khal Drogo', 'Betrothed to')], ['Blood of the dragon'])
piece('viserys', 'Viserys Targaryen', 'character', "Dany's older brother, who calls himself the rightful king. Bitter, cruel and impatient to win an army.", ['Viserys', 'the Beggar King'], [('House Targaryen', 'Member of'), ('Robert Baratheon', 'Enemy'), ('Illyrio Mopatis', 'Ally')], ['Blood of the dragon'])
piece('illyrio', 'Illyrio Mopatis', 'character', "A rich, fat magister of Pentos who hosts the Targaryen exiles and arranges the match with Khal Drogo.", ['Illyrio', 'Magister Illyrio'], [('Viserys Targaryen', 'Ally')])
piece('drogo', 'Khal Drogo', 'character', "A Dothraki warlord who has never been defeated, leading a horde of tens of thousands.", ['Drogo', 'the khal'], [('Dothraki', 'Member of')])
piece('will', 'Will', 'character', "A ranger of the Night's Watch, once a poacher.", [], [('Night\'s Watch', 'Member of')])
piece('waymar', 'Waymar Royce', 'character', "A young, highborn and overconfident ranger leading his first ranging.", ['Ser Waymar', 'Royce'], [('Night\'s Watch', 'Member of')])
piece('gared', 'Gared', 'character', "A veteran ranger of the Night's Watch. Flees south after the ranging and is caught as a deserter.", [], [('Night\'s Watch', 'Member of')])
# Factions
piece('hstark', 'House Stark', 'faction', "Lords of Winterfell and the North for thousands of years. Sigil: a grey direwolf. Words: Winter is Coming.", ['the Starks'], [], ['Winter is coming'])
piece('hlannister', 'House Lannister', 'faction', "The richest house in the realm, seated at Casterly Rock. Sigil: a golden lion.", ['the Lannisters'])
piece('hbaratheon', 'House Baratheon', 'faction', "The royal house since Robert's rebellion. Sigil: a crowned stag.", ['the Baratheons'], [('House Lannister', 'Ally')])
piece('htargaryen', 'House Targaryen', 'faction', "The dragon kings who ruled for three centuries before Robert's rebellion; now just two exiles.", ['the Targaryens'], [], ['Blood of the dragon'])
piece('harryn', 'House Arryn', 'faction', "Lords of the Vale, seated at the Eyrie.", ['the Arryns'])
piece('nightswatch', "Night's Watch", 'faction', "The sworn brotherhood that holds the Wall. Its members give up lands, titles and families.", ['the Watch', 'black brothers'])
piece('dothraki', 'Dothraki', 'faction', "Horse lords of the eastern grasslands who ride in vast hordes called khalasars.", [])
piece('others', 'The Others', 'faction', "Pale, silent beings out of legend, thought by most southerners to be a story told to frighten children.", ['the Others', 'White Walkers'], [('Waymar Royce', 'Killed')], ['Winter is coming'])
# Creatures
for id, name, owner in [('greywind', 'Grey Wind', 'Robb'), ('lady', 'Lady', 'Sansa'), ('nymeria', 'Nymeria', 'Arya'), ('summer', 'Summer', 'Bran'), ('shaggydog', 'Shaggydog', 'Rickon'), ('ghost', 'Ghost', 'Jon')]:
    extra = " The runt of the litter: white with red eyes, found apart from the others. It makes no sound." if id == 'ghost' else (" Bran hasn't named it yet at this point." if id == 'summer' else '')
    piece(id, name, 'creature', f"A direwolf pup, {owner}'s, from the litter found beside their dead mother.{extra}", [], [], ['Winter is coming'])
# Items
piece('ice', 'Ice', 'item', "Ned's ancestral greatsword of Valyrian steel, as tall as a man. He uses it for executions.", [], [], ['Honour'])
# Places on the world map, then inside Winterfell (its own map)
MAIN_PLACES = [
    ('haunted', 'The Haunted Forest', "Endless forest north of the Wall, beyond the reach of the Seven Kingdoms.", (.24, .07)),
    ('castleblack', 'Castle Black', "Headquarters of the Night's Watch, at the foot of the Wall.", (.25, .17)),
    ('holdfast', 'Old holdfast', "A ruined holdfast in the hills near Winterfell, where Ned holds the execution. On the way back, the party finds the direwolves by a stream.", (.13, .215)),
    ('wolfswood', 'The Wolfswood', "Old forest west of Winterfell. The king's hunt rides here.", (.12, .32)),
    ('winterfell', 'Winterfell', "The ancient seat of House Stark. Double-click it on the map to go inside.", (.24, .28)),
    ('moatcailin', 'Moat Cailin', "Ruined fortress guarding the causeway through the Neck: the gate to the North.", (.27, .405)),
    ('twins', 'The Twins', "Twin castles of House Frey, holding the only bridge over the Green Fork for many leagues.", (.235, .48)),
    ('riverrun', 'Riverrun', "Seat of House Tully, where Catelyn and Lysa grew up.", (.19, .565)),
    ('crossroads', 'The crossroads inn', "An inn where the Kingsroad meets the River Road. A natural stop for travellers going north or south.", (.28, .605)),
    ('eyrie', 'The Eyrie', "Seat of House Arryn, high up in the Mountains of the Moon.", (.375, .5)),
    ('casterly', 'Casterly Rock', "Seat of House Lannister, on the western coast.", (.09, .63)),
    ('kingslanding', "King's Landing", "The capital, where the Iron Throne stands.", (.36, .7)),
    ('dragonstone', 'Dragonstone', "An island fortress off the coast, once the Targaryens' first foothold in Westeros.", (.46, .655)),
    ('stormsend', "Storm's End", "Seat of House Baratheon, on the stormy south-east coast.", (.4, .8)),
    ('pyke', 'Pyke', "Seat of House Greyjoy, on the Iron Islands. Theon's home.", (.045, .48)),
    ('pentos', 'Pentos', "A wealthy free city across the Narrow Sea. Illyrio's manse is here.", (.665, .52)),
]
WF_PLACES = [
    ('greatkeep', 'The Great Keep', "The Starks' home within the castle: bedchambers, the lord's solar and the family's rooms.", (.51, .24)),
    ('greathall', 'The Great Hall', "Long hall with a high table and rows of benches; feasts are held here.", (.245, .46)),
    ('guesthouse', 'The guest house', "Lodgings for visiting lords. The royal family stays here.", (.77, .625)),
    ('sept', 'The sept', "A small sept built for Catelyn, who keeps the faith of the Seven.", (.74, .84)),
    ('turret', "Maester's turret", "Maester Luwin's rooms and the rookery for the ravens.", (.72, .2)),
    ('brokentower', 'The broken tower', "A tower abandoned since lightning burned its top. Bran's favourite climb. No roof left.", (.82, .28)),
    ('firstkeep', 'The First Keep', "The oldest part of the castle: a squat round drum tower, empty for centuries.", (.23, .23)),
    ('crypts', 'The crypts', "Below the castle, the stone kings of winter sit with iron swords across their knees. Lyanna Stark lies here.", (.24, .72)),
    ('godswood', 'The godswood', "Ancient forest kept within the walls, around a white weirwood heart tree with a carved red face.", (.5, .765)),
    ('yard', 'The practice yard', "Where the boys of Winterfell train with blunted swords.", (.76, .45)),
    ('kennels', 'The kennels', "Hounds, and now six direwolf pups.", (.77, .745)),
    ('courtyard', 'The main courtyard', "The great yard inside the gates, where the household turns out to greet guests.", (.5, .51)),
    ('gatehouse', 'The gatehouse', "The way in and out through the double walls.", (.5, .925)),
]
for id, name, desc, _ in MAIN_PLACES + WF_PLACES:
    piece(id, name, 'place', desc)
# Events
EV = [
    ('ev-ambush', 'The ranging goes wrong', "Beyond the Wall, Waymar Royce's patrol meets the Others. Waymar falls, then rises again; Gared flees.", 's1', 'haunted', ['Will', 'Waymar Royce', 'Gared', 'The Others']),
    ('ev-execution', "Gared's execution", "Ned beheads the deserter with Ice while his sons watch.", 's2', 'holdfast', ['Eddard Stark', 'Gared', 'Bran Stark', 'Robb Stark', 'Jon Snow', 'Theon Greyjoy', 'Ice']),
    ('ev-pups', 'The direwolf pups are found', "A dead direwolf lies by a stream with a stag's antler in her throat, and six living pups, one for each Stark child.", 's3', 'holdfast', ['Jon Snow', 'Robb Stark', 'Bran Stark', 'Eddard Stark', 'Theon Greyjoy']),
    ('ev-arryn', "News of Jon Arryn's death", "A raven brings word that the Hand of the King is dead, and that King Robert is riding north.", 's4', 'godswood', ['Catelyn Stark', 'Eddard Stark', 'Jon Arryn']),
    ('ev-drogo', 'Daenerys is shown to Khal Drogo', "Viserys and Illyrio present Dany to the khal, trading her for the promise of an army.", 's5', 'pentos', ['Daenerys Targaryen', 'Viserys Targaryen', 'Illyrio Mopatis', 'Khal Drogo']),
    ('ev-hand', 'Robert asks Ned to be his Hand', "In the crypts below Winterfell, Robert offers Ned the Handship and proposes joining their houses by marriage.", 's6', 'crypts', ['Robert Baratheon', 'Eddard Stark']),
    ('ev-feast', 'The welcome feast', "Winterfell feasts the royal party. Jon sits apart with the squires and talks with Benjen and Tyrion.", 's7', 'greathall', ['Jon Snow', 'Benjen Stark', 'Tyrion Lannister']),
    ('ev-letter', "Lysa's hidden letter", "Maester Luwin brings Catelyn a secret message from Lysa: Jon Arryn was murdered, and she names the Lannisters.", 's8', 'greatkeep', ['Catelyn Stark', 'Eddard Stark', 'Maester Luwin', 'Lysa Arryn']),
    ('ev-fall', "Bran's fall", "Climbing the broken tower, Bran sees something he shouldn't, and is pushed from the window.", 's10', 'brokentower', ['Bran Stark', 'Jaime Lannister', 'Cersei Lannister']),
]
for id, name, desc, s, where, inv in EV:
    piece(id, name, 'event', desc, [], [(n, 'Involved in') for n in inv])

FOLDER = {'character': 'Characters', 'faction': 'Factions', 'creature': 'Creatures', 'item': 'Items', 'place': 'Places', 'event': 'Events'}
names = {p['name'] for p in P}
for p in P:
    for t, _ in p['conns']: assert t in names, (p['name'], t)
    fm = f"se-id: {p['id']}\nse-type: {p['type']}\n"
    if p['aliases']: fm += 'aliases:\n' + ''.join(f'  - {yq(a)}\n' for a in p['aliases'])
    if p['conns']: fm += 'connections:\n' + ''.join(f'  - {yq(f"[[{t}]] · {l}")}\n' for t, l in p['conns'])
    if p['themes']: fm += 'themes:\n' + ''.join(f'  - {yq(t)}\n' for t in p['themes'])
    fname = p['name'].replace(':', ' ').replace('/', ' ')
    w(f"World/{FOLDER[p['type']]}/{fname}.md", f"---\n{fm}---\n\n{p['desc']}\n")

# ── chapters: scene summaries (original paraphrase) ─────────────────────
def sc(meta): return '%% se-scene ' + ' '.join(f'{k}={v}' for k, v in meta.items()) + ' %%'
CH = [
  ('01 Prologue', 'PROLOGUE', [({'id': 's1', 'pov': 'will', 'where': 'haunted', 'moment': 'm298'},
    "Three rangers of the Night's Watch ride beyond the Wall: Ser Waymar Royce leads Will and Gared after a band of wildlings. Will reports finding the wildlings dead, but when they return to the spot the bodies are gone. Waymar refuses to turn back. Pale figures step out of the trees: the Others. Waymar fights alone and is cut down while Will watches from a tree. Then the dead knight gets up again. Gared, waiting with the horses, flees south.")]),
  ('02 Bran I', 'BRAN I', [({'id': 's2', 'pov': 'bran', 'where': 'holdfast'},
    "Bran rides out with his father, Robb, Jon and Theon Greyjoy to see the king's justice done. The prisoner is Gared, a deserter from the Night's Watch, raving that he saw the Others. Eddard Stark takes the head himself with Ice. On the ride home, Ned tells Bran why the man who passes the sentence must swing the sword."),
    ({'id': 's3', 'pov': 'bran', 'where': 'holdfast'},
    "By a stream they find a dead direwolf, killed by a stag's antler, and her five pups. Theon wants to kill them; Jon points out there is one for each of Ned's trueborn children, and Ned relents. As they leave, Jon hears something and comes back with a sixth pup, a silent white runt with red eyes, for himself.")]),
  ('03 Catelyn I', 'CATELYN I', [({'id': 's4', 'pov': 'cat', 'where': 'godswood'},
    "Catelyn finds Ned cleaning Ice beneath the heart tree in the godswood. She brings news from a raven: Jon Arryn, the Hand of the King, is dead. Worse, King Robert is coming north to Winterfell, and Catelyn guesses what he will ask.")]),
  ('04 Daenerys I', 'DAENERYS I', [({'id': 's5', 'pov': 'dany', 'where': 'pentos', 'with': 's4'},
    "In Magister Illyrio's manse in Pentos, Viserys dresses his sister for a feast and warns her not to wake the dragon. At the feast Illyrio presents Daenerys to Khal Drogo. Viserys is sure the match will win him an army to retake the Iron Throne; Dany is terrified.")]),
  ('05 Eddard I', 'EDDARD I', [({'id': 's6', 'pov': 'ned', 'where': 'crypts', 'moment': 'mvisit'},
    "Robert arrives at Winterfell with the queen, her brothers and the royal children. He asks to go down to the crypts first, to see the tomb of Lyanna Stark. There, among the dead kings of winter, Robert asks Ned to come south as his Hand, and suggests marrying Joffrey to Sansa.")]),
  ('06 Jon I', 'JON I', [({'id': 's7', 'pov': 'jon', 'where': 'greathall'},
    "At the welcome feast, Jon is seated with the squires so as not to insult the queen. He watches his family at the high table, drinks too much, and talks with his uncle Benjen about joining the Night's Watch. Outside, Tyrion Lannister gives him harsh advice: own what you are, and nobody can use it against you.")]),
  ('07 Catelyn II', 'CATELYN II', [({'id': 's8', 'pov': 'cat', 'where': 'greatkeep'},
    "Late at night Maester Luwin brings Catelyn a message hidden in a box, written in her sister Lysa's private code. Lysa says Jon Arryn was murdered, and that the Lannisters were behind it. Catelyn and Ned weigh what it means for his answer to the king.")]),
  ('08 Arya I', 'ARYA I', [({'id': 's9', 'pov': 'arya', 'where': 'yard'},
    "Needlework is torture for Arya: Sansa's stitches come out perfect while hers are a mess. Septa Mordane scolds her and the other girls gossip about Prince Joffrey. Arya flees to the practice yard, where Jon is watching Bran spar with Prince Tommen while Robb and Joffrey look on. Jon is the one person who never makes her feel like she's doing everything wrong.")]),
  ('09 Bran II', 'BRAN II', [({'id': 's10', 'pov': 'bran', 'where': 'brokentower'},
    "On the day of the royal hunt, Bran stays behind and climbs the walls of Winterfell as he always does. At a window of the broken tower he overhears two people he shouldn't, and sees what they are doing. Jaime Lannister catches him at the sill, and pushes him out.")]),
]
for fname, title, scenes in CH:
    # One line per paragraph (Story Engine 2.11).
    body = f"---\ncssclasses: manuscript\n---\n# {title}\n"
    body += '\n✦ ✦ ✦\n'.join(f"{sc(m)}\n{t}" for m, t in scenes) + '\n'
    w(f"{fname}.md", body)

# ── maps (original drawings, not the book's maps) ─────────────────────────
def poly(pts): return ' '.join(f'{x},{y}' for x, y in pts)
WESTEROS = [(80,20),(420,25),(452,90),(410,150),(442,230),(402,300),(362,360),(332,408),(362,450),(432,470),(452,520),(422,580),(442,640),(402,690),(442,730),(432,790),(472,850),(422,900),(342,960),(242,975),(150,940),(90,880),(60,800),(90,720),(60,640),(70,580),(110,520),(100,470),(150,430),(180,410),(140,360),(90,330),(60,260),(90,190),(60,120)]
ESSOS = [(560,250),(700,228),(860,262),(995,300),(995,905),(860,952),(720,902),(620,822),(580,722),(602,640),(572,560),(602,480),(562,400),(582,320)]
def trees(cx, cy, rx, ry, n, seed, color='#2c4a2a'):
    import random; r = random.Random(seed); out = []
    for _ in range(n):
        a, d = r.random() * 6.283, r.random() ** .5
        import math; x, y = cx + math.cos(a) * rx * d, cy + math.sin(a) * ry * d
        out.append(f'<path d="M{x:.1f} {y-7:.1f} l5 10 h-10 z" fill="{color}" opacity=".85"/>')
    return ''.join(out)
def mountains(pts):
    return ''.join(f'<path d="M{x-11} {y+7} L{x} {y-9} L{x+11} {y+7} Z" fill="#6d6458" stroke="#3f3a33" stroke-width="1.2"/><path d="M{x-3} {y-4} L{x} {y-9} L{x+3} {y-4}" fill="#e8e4dc"/>' for x, y in pts)
world = f'''<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000" viewBox="0 0 1000 1000">
<defs>
 <radialGradient id="sea" cx="45%" cy="45%" r="80%"><stop offset="0" stop-color="#1d3a57"/><stop offset="1" stop-color="#0d1c2b"/></radialGradient>
 <linearGradient id="land" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4d5a4c"/><stop offset=".18" stop-color="#3f5235"/><stop offset=".55" stop-color="#4c5a33"/><stop offset="1" stop-color="#5d5a34"/></linearGradient>
 <pattern id="swamp" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 6 q2 -3 4 0 t4 0" stroke="#5f7a52" fill="none" stroke-width="1"/></pattern>
 <pattern id="waves" width="40" height="14" patternUnits="userSpaceOnUse"><path d="M0 7 q5 -4 10 0 t10 0" stroke="#ffffff10" fill="none"/></pattern>
</defs>
<rect width="1000" height="1000" fill="url(#sea)"/><rect width="1000" height="1000" fill="url(#waves)"/>
<polygon points="{poly(WESTEROS)}" fill="url(#land)" stroke="#9aa77d" stroke-width="2.5" stroke-linejoin="round"/>
<polygon points="{poly(ESSOS)}" fill="#5b5636" stroke="#a69a6c" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M75 22 L420 26 L452 90 L430 120 L80 120 Z" fill="#dfe6ea" opacity=".12"/>
<ellipse cx="45" cy="480" rx="20" ry="13" fill="#4a5038" stroke="#9aa77d" stroke-width="2"/><ellipse cx="30" cy="505" rx="9" ry="7" fill="#4a5038" stroke="#9aa77d" stroke-width="2"/>
<ellipse cx="462" cy="655" rx="14" ry="10" fill="#45463a" stroke="#9aa77d" stroke-width="2"/>
<path d="M150 425 Q240 440 330 412 L345 452 Q250 470 160 455 Z" fill="url(#swamp)" opacity=".9"/>
<g fill="none" stroke="#6f9bc7" stroke-width="2.4" stroke-linecap="round" opacity=".85">
 <path d="M215 250 Q200 310 230 360 T262 420"/><path d="M190 470 Q215 520 245 540 Q270 575 285 600 Q320 640 352 690"/><path d="M300 470 Q300 520 285 600"/>
 <path d="M150 560 Q190 565 205 570"/><path d="M120 690 Q230 690 352 700"/><path d="M420 50 L440 40"/>
</g>
<path d="M75 150 L447 150" stroke="#f2f6f9" stroke-width="6" stroke-linecap="round"/><path d="M75 150 L447 150" stroke="#9fc4dd" stroke-width="2" stroke-dasharray="2 6"/>
<path d="M250 165 L242 278 L270 400 L276 470 L280 600 L330 650 L358 698" fill="none" stroke="#e8d9a8" stroke-width="1.8" stroke-dasharray="5 5" opacity=".7"/>
<path d="M280 600 L250 580 L195 565" fill="none" stroke="#e8d9a8" stroke-width="1.4" stroke-dasharray="4 5" opacity=".55"/>
{trees(240, 85, 150, 45, 160, 1, '#22392a')}{trees(115, 300, 45, 55, 45, 2)}{trees(395, 770, 35, 35, 30, 3)}{trees(170, 230, 40, 25, 18, 4)}
{mountains([(360,470),(385,485),(400,505),(372,520),(395,540),(350,500),(415,470)])}{mountains([(110,560),(125,600),(95,610)])}{mountains([(860,330),(890,350),(920,330),(900,380)])}
<g font-family="Georgia, serif" font-style="italic" fill="#efe7cf" opacity=".5" text-anchor="middle">
 <text x="250" y="50" font-size="17">Beyond the Wall</text><text x="250" y="355" font-size="20">The North</text><text x="230" y="520" font-size="15">The Riverlands</text>
 <text x="415" y="555" font-size="13">The Vale</text><text x="120" y="660" font-size="14">The Westerlands</text><text x="330" y="745" font-size="13">The Crownlands</text>
 <text x="380" y="860" font-size="14">The Stormlands</text><text x="250" y="900" font-size="15">The Reach</text><text x="230" y="435" font-size="11">The Neck</text>
 <text x="800" y="620" font-size="30">Essos</text><text x="515" y="560" font-size="15" transform="rotate(-78 515 560)">The Narrow Sea</text>
 <text x="30" y="330" font-size="14" transform="rotate(-90 30 330)">The Sunset Sea</text><text x="320" y="138" font-size="10" font-style="normal" letter-spacing="3">THE WALL</text>
</g>
<text x="14" y="988" font-family="sans-serif" font-size="11" fill="#fff" opacity=".4">Sketch map drawn for the Story Engine sample. Not to scale; not the book's map.</text>
</svg>'''
w('Attachments/World map.svg', world)

# Winterfell castle plan with interiors. Building roofs are separate pictures (Attachments/Roofs) that cover these.
def rect(x, y, w_, h_, fill, stroke='#2b2620', sw=3, rx=2): return f'<rect x="{x}" y="{y}" width="{w_}" height="{h_}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" rx="{rx}"/>'
def label(x, y, t, size=15): return f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="middle">{t}</text>'
hall_tables = ''.join(rect(185, 395 + i * 34, 120, 9, '#7a5a3a', '#3d2c1d', 1.5, 1) for i in range(5)) + rect(180, 370, 130, 10, '#8a6640', '#3d2c1d', 1.5, 1) + rect(300, 520, 22, 30, '#c56a2a', '#5a2d10', 2, 2)
keep_rooms = rect(410, 160, 95, 75, '#5a5249') + rect(510, 160, 100, 75, '#5a5249') + rect(410, 240, 200, 80, '#5a5249') + '<rect x="440" y="270" width="40" height="22" fill="#7a3a3a"/><rect x="545" y="185" width="35" height="22" fill="#3a5a7a"/>'
tombs = ''.join(f'<rect x="{180 + c * 40}" y="{640 + r * 42}" width="22" height="30" fill="#77736b" stroke="#3a3833" stroke-width="1.5"/>' for r in range(4) for c in range(4))
gods = trees(500, 765, 125, 70, 70, 9, '#1f3b22') + '<circle cx="500" cy="760" r="16" fill="#f1ede4"/><circle cx="494" cy="756" r="5" fill="#b0192a"/><circle cx="506" cy="756" r="5" fill="#b0192a"/><ellipse cx="545" cy="800" rx="26" ry="12" fill="#5f8fb0" opacity=".8"/>'
winterfell = f'''<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000" viewBox="0 0 1000 1000">
<defs><pattern id="cob" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#6a665e"/><path d="M0 7 H14 M7 0 V7 M0 14 H14 M3 7 V14 M11 7 V14" stroke="#58544d" stroke-width="1"/></pattern>
<pattern id="sand" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#a8946a"/><circle cx="2" cy="2" r=".7" fill="#8c7a55"/></pattern>
<pattern id="snow" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#3b4537"/><circle cx="4" cy="6" r="1" fill="#dfe8ee" opacity=".35"/><circle cx="14" cy="15" r="1" fill="#dfe8ee" opacity=".3"/></pattern></defs>
<rect width="1000" height="1000" fill="url(#snow)"/>
<rect x="40" y="40" width="920" height="920" fill="#2e4b62" rx="30"/>
<rect x="60" y="60" width="880" height="880" fill="#4f4c47" stroke="#2b2925" stroke-width="10" rx="24"/>
<rect x="100" y="100" width="800" height="800" fill="url(#cob)" stroke="#2b2925" stroke-width="10" rx="16"/>
{''.join(f'<circle cx="{x}" cy="{y}" r="22" fill="#55524c" stroke="#2b2925" stroke-width="5"/>' for x, y in [(100,100),(900,100),(100,900),(900,900),(500,100),(100,500),(900,500)])}
{rect(355, 380, 290, 270, '#7c776d', '#4a463f', 2, 6)}
{rect(400, 150, 220, 180, '#3f3a35')}{keep_rooms}
{rect(160, 360, 170, 200, '#4a4036')}{hall_tables}
{rect(690, 560, 160, 130, '#45403a')}{rect(700, 570, 65, 50, '#5a5249')}{rect(775, 570, 65, 50, '#5a5249')}{rect(700, 630, 140, 50, '#5a5249')}
{rect(680, 800, 120, 80, '#544c40')}<polygon points="740,812 755,826 750,846 730,846 725,826" fill="#d8c48a"/>
<circle cx="720" cy="200" r="40" fill="#3f3a35" stroke="#2b2620" stroke-width="3"/><circle cx="720" cy="200" r="14" fill="#6a5a3a"/>
<circle cx="820" cy="280" r="46" fill="#2f2b28" stroke="#1d1a17" stroke-width="5"/><circle cx="820" cy="280" r="30" fill="#232120"/><path d="M790 250 l18 14 l-6 18 l20 6" stroke="#0f0d0c" stroke-width="3" fill="none"/>
<circle cx="230" cy="230" r="62" fill="#4b4741" stroke="#2b2620" stroke-width="5"/><circle cx="230" cy="230" r="42" fill="#3d3a35"/>
{rect(160, 620, 160, 200, '#2a2826', '#141312', 3)}{tombs}<rect x="300" y="618" width="20" height="18" fill="#141312"/>
{rect(370, 690, 260, 160, '#2f4a2c', '#1d2e1b', 3, 18)}{gods}
{rect(680, 380, 160, 140, 'url(#sand)', '#6e6040', 2, 4)}<path d="M710 420 l100 70 M810 420 l-100 70" stroke="#6e6040" stroke-width="2" opacity=".5"/>
{rect(690, 710, 160, 70, '#4e463a')}{''.join(f'<rect x="{700 + i * 30}" y="{722}" width="22" height="46" fill="#3a332a"/>' for i in range(5))}
{rect(470, 880, 60, 50, '#3a3631', '#1d1a17', 4)}<rect x="485" y="900" width="30" height="30" fill="#1d1a17"/>

<text x="16" y="990" font-family="sans-serif" font-size="11" fill="#fff" opacity=".45">Winterfell, drawn for the Story Engine sample. Inside map: opens from Winterfell on the world map.</text>
</svg>'''
w('Attachments/Winterfell.svg', winterfell)

# Roofs: (place, rect on the Winterfell map as fractions, file name, colours)
ROOFS = [
    ('greatkeep', (.40, .15, .22, .18), 'Great Keep roof', ('#4b5560', '#36404a')),
    ('greathall', (.16, .36, .17, .20), 'Great Hall roof', ('#6a4a35', '#4d3526')),
    ('guesthouse', (.69, .56, .16, .13), 'Guest house roof', ('#5b6b55', '#45533f')),
    ('sept', (.68, .80, .12, .08), 'Sept roof', ('#8a7650', '#6b5a3a')),
    ('turret', (.68, .16, .08, .08), 'Turret roof', ('#4b5560', '#36404a')),
    ('crypts', (.16, .62, .16, .20), 'Crypts cover', None),
]
for pid, (x, y, rw, rh), fname, cols in ROOFS:
    W, H = int(rw * 1000), int(rh * 1000)
    if cols:
        a, b_ = cols
        horiz = W >= H
        tiles = (f'<pattern id="t" width="12" height="8" patternUnits="userSpaceOnUse"><rect width="12" height="8" fill="{a}"/><path d="M0 8 H12 M6 0 V8" stroke="{b_}" stroke-width="1.2"/></pattern>')
        ridge = f'<line x1="{6}" y1="{H/2}" x2="{W-6}" y2="{H/2}"' if horiz else f'<line x1="{W/2}" y1="6" x2="{W/2}" y2="{H-6}"'
        body = f'<defs>{tiles}<linearGradient id="g" x1="0" y1="0" x2="{0 if horiz else 1}" y2="{1 if horiz else 0}"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".5" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient></defs><rect width="{W}" height="{H}" fill="url(#t)" rx="3"/><rect width="{W}" height="{H}" fill="url(#g)" rx="3"/>{ridge} stroke="#1c1a18" stroke-width="3"/>'
    else:
        body = f'<defs><pattern id="gr" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#4f5a44"/><circle cx="3" cy="4" r="1" fill="#e7eef2" opacity=".4"/></pattern></defs><rect width="{W}" height="{H}" fill="url(#gr)" rx="6"/><rect x="{W-48}" y="4" width="40" height="26" fill="#2a2724" stroke="#141312" stroke-width="2"/><path d="M{W-44} 10 h32 M{W-44} 17 h32 M{W-44} 24 h32" stroke="#6a655c" stroke-width="2"/>'
    w(f'Attachments/Roofs/{fname}.svg', f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{body}</svg>')

# Place areas: traced shapes (fractions of each map). Anything not listed keeps the default circle.
def box(x0, y0, x1, y1): return [{'x': x0, 'y': y0}, {'x': x1, 'y': y0}, {'x': x1, 'y': y1}, {'x': x0, 'y': y1}]
def ring(cx, cy, r, n=16):
    import math
    return [{'x': round(cx + math.cos(i / n * 6.2832) * r, 4), 'y': round(cy + math.sin(i / n * 6.2832) * r, 4)} for i in range(n)]
AREAS = {
    # Winterfell, room by room (the courtyard is the open ground between them)
    'greatkeep': box(.40, .15, .62, .33), 'greathall': box(.16, .36, .33, .56), 'guesthouse': box(.69, .56, .85, .69), 'sept': box(.68, .80, .80, .88),
    'crypts': box(.16, .62, .32, .82), 'godswood': box(.37, .69, .63, .85), 'yard': box(.68, .38, .84, .52), 'kennels': box(.69, .71, .85, .78),
    'courtyard': box(.355, .38, .645, .65), 'gatehouse': box(.47, .88, .53, .93),
    'turret': ring(.72, .2, .04), 'brokentower': ring(.82, .28, .046), 'firstkeep': ring(.23, .23, .062),
    # The world: the forests are big, Winterfell is the castle and its walls
    'haunted': [{'x': .09, 'y': .03}, {'x': .42, 'y': .03}, {'x': .445, 'y': .09}, {'x': .43, 'y': .145}, {'x': .08, 'y': .145}],
    'wolfswood': [{'x': .07, 'y': .245}, {'x': .155, 'y': .24}, {'x': .175, 'y': .3}, {'x': .16, 'y': .365}, {'x': .075, 'y': .37}, {'x': .06, 'y': .31}],
    'winterfell': ring(.24, .28, .028, 12),
}

# Every place has an icon from Story Engine's built-in set (inside Winterfell too).
ICONS = {pid: 'builtin:' + kind for pid, kind in {
    'haunted': 'forest', 'castleblack': 'wall', 'holdfast': 'ruin', 'wolfswood': 'forest', 'winterfell': 'castle', 'moatcailin': 'ruin',
    'twins': 'gate', 'riverrun': 'castle', 'crossroads': 'inn', 'eyrie': 'tower', 'casterly': 'castle', 'kingslanding': 'city',
    'dragonstone': 'island', 'stormsend': 'keep', 'pyke': 'island', 'pentos': 'city',
    'greatkeep': 'keep', 'greathall': 'hall', 'guesthouse': 'house', 'sept': 'sept', 'turret': 'library', 'brokentower': 'ruin',
    'firstkeep': 'tower', 'crypts': 'crypt', 'godswood': 'tree', 'yard': 'armoury', 'kennels': 'stable', 'courtyard': 'well', 'gatehouse': 'gate',
}.items()}

# ── story-engine.json ─────────────────────────────────────────────────
styles = json.load(open(os.path.join(os.path.dirname(__file__), 'styles.json')))
other = styles.pop()  # keep "Other" last
styles += [
    {'id': 'married', 'label': 'Married to', 'color': '#f5d78e', 'dash': 'solid', 'width': 2.2, 'arrow': 'both'},
    {'id': 'member', 'label': 'Member of', 'color': '#8fa3b8', 'dash': 'dotted', 'width': 1.3, 'arrow': 'end'},
    {'id': 'ward', 'label': 'Ward of', 'color': '#a8d8c0', 'dash': 'dashed', 'width': 1.6, 'arrow': 'end'},
    {'id': 'betrothed', 'label': 'Betrothed to', 'color': '#f7b6d2', 'dash': 'dashed', 'width': 1.6, 'arrow': 'both'},
    {'id': 'attacked', 'label': 'Attacked', 'color': '#ff4d5e', 'dash': 'solid', 'width': 2.6, 'arrow': 'end'},
    other]
places = {id: {'x': x, 'y': y} for id, _, _, (x, y) in MAIN_PLACES}
places.update({id: {'x': x, 'y': y, 'map': 'mwf'} for id, _, _, (x, y) in WF_PLACES})
track = {}
def at(pid, s, place=None, gone=False, spot=None, dead=False):
    e = {'s': s}
    if gone or dead: e['gone'] = True
    if dead: e['dead'] = True
    elif place:
        e['place'] = place
        if spot: e['off'] = {'x': round(spot[0] - places[place]['x'], 4), 'y': round(spot[1] - places[place]['y'], 4)}
    track.setdefault(pid, []).append(e)
def spots(s, place, pairs):
    for pid, xy in pairs: at(pid, s, place, spot=xy)
STARK_KIDS = ['robb', 'jon', 'sansa', 'arya', 'bran', 'rickon']
ROYALS = ['robert', 'cersei', 'jaime', 'tyrion', 'joffrey', 'myrcella', 'tommen', 'sandor']
PUPS = ['greywind', 'lady', 'nymeria', 'summer', 'shaggydog', 'ghost']
# s1 Prologue: beyond the Wall. Everyone else where the story finds them.
spots('s1', 'haunted', [('waymar', (.25, .075)), ('will', (.205, .085)), ('gared', (.17, .105)), ('others', (.28, .06))])
at('benjen', 's1', 'castleblack'); at('lysa', 's1', 'eyrie')
for p in ROYALS: at(p, 's1', 'kingslanding')
for p in ['dany', 'viserys', 'illyrio']: at(p, 's1', 'pentos')
at('drogo', 's1', 'pentos', spot=(.69, .525))        # the khalasar camps outside the city
for p in ['cat', 'sansa', 'arya', 'rickon']: at(p, 's1', 'greatkeep')
spots('s1', 'courtyard', [('ned', (.47, .47)), ('robb', (.50, .455)), ('jon', (.535, .47)), ('bran', (.485, .5)), ('theon', (.555, .5))])
at('luwin', 's1', 'turret')
# s2-s3 Bran I: the execution, then the pups by the stream.
for p in ['will', 'waymar']: at(p, 's2', dead=True)   # killed beyond the Wall in the prologue
for p in ['ned', 'robb', 'jon', 'bran', 'theon', 'gared']: at(p, 's2', 'holdfast')
at('gared', 's3', dead=True)   # beheaded for deserting
for p in PUPS: at(p, 's3', 'holdfast')
# s4 Catelyn I: Ned on his stone by the black pool under the heart tree; Cat comes to him. The boys are back in the yard.
spots('s4', 'godswood', [('ned', (.535, .785)), ('cat', (.47, .8))])
spots('s4', 'courtyard', [('robb', (.46, .44)), ('jon', (.52, .43)), ('bran', (.42, .56)), ('theon', (.58, .45))])
for p in PUPS: at(p, 's4', 'kennels')
for p in ROYALS: at(p, 's4', 'crossroads')     # the king's party on the Kingsroad north
# s6 Eddard I: the household lines up in the courtyard; Robert and Ned go down to Lyanna's tomb.
spots('s6', 'crypts', [('robert', (.215, .78)), ('ned', (.25, .775))])
spots('s6', 'courtyard', [('luwin', (.39, .43)), ('cat', (.42, .42)), ('robb', (.45, .42)), ('sansa', (.48, .42)), ('arya', (.51, .42)), ('bran', (.54, .42)), ('rickon', (.57, .42)), ('theon', (.62, .44)), ('jon', (.625, .48)),
    ('tyrion', (.44, .61)), ('cersei', (.48, .6)), ('joffrey', (.51, .615)), ('jaime', (.535, .585)), ('myrcella', (.55, .62)), ('tommen', (.58, .62)), ('sandor', (.61, .6))])
# s7 Jon I: the feast. High table along the top (Ned beside the queen, Robert beside Catelyn); Jon down among the squires.
spots('s7', 'greathall', [('sansa', (.18, .38)), ('cersei', (.205, .375)), ('ned', (.23, .375)), ('robert', (.255, .375)), ('cat', (.28, .375)), ('joffrey', (.305, .38)), ('sandor', (.32, .395)),
    ('robb', (.21, .405)), ('theon', (.25, .405)), ('jaime', (.29, .41)), ('arya', (.2, .44)), ('bran', (.23, .44)), ('myrcella', (.27, .44)), ('tommen', (.3, .445)), ('rickon', (.205, .475)),
    ('luwin', (.18, .5)), ('jon', (.2, .53)), ('benjen', (.23, .525)), ('tyrion', (.31, .545))])
# s8 Catelyn II: late that night. Ned and Cat in their chamber when Luwin brings the letter; the guests in the guest house.
spots('s8', 'greatkeep', [('ned', (.44, .2)), ('cat', (.465, .2)), ('luwin', (.49, .215)), ('sansa', (.53, .19)), ('arya', (.56, .19)), ('bran', (.53, .215)), ('rickon', (.585, .195)),
    ('robb', (.45, .28)), ('jon', (.5, .29)), ('theon', (.56, .28))])
spots('s8', 'guesthouse', [('robert', (.72, .59)), ('cersei', (.745, .6)), ('jaime', (.8, .59)), ('tyrion', (.825, .6)), ('joffrey', (.73, .66)), ('myrcella', (.76, .66)), ('tommen', (.79, .66)), ('sandor', (.82, .665)), ('benjen', (.705, .675))])
# s9 Arya I: Bran and Tommen spar in the middle of the yard; Robb, Joffrey and the Hound watch; Jon and Arya by the edge.
spots('s9', 'yard', [('bran', (.73, .455)), ('tommen', (.78, .455)), ('robb', (.70, .405)), ('joffrey', (.745, .4)), ('sandor', (.785, .395)), ('theon', (.705, .5)), ('jon', (.825, .43)), ('arya', (.825, .475)), ('ghost', (.795, .505)), ('nymeria', (.835, .505))])
for p in ['sansa', 'myrcella']: at(p, 's9', 'greatkeep')
# s10 Bran II: the king and Ned ride out to hunt; Bran on the outside of the broken tower; Jaime and Cersei inside.
spots('s10', 'wolfswood', [('robert', (.1, .3)), ('ned', (.125, .31))])
spots('s10', 'brokentower', [('bran', (.795, .255)), ('jaime', (.825, .28)), ('cersei', (.835, .292))])
EV_SPOT = {'ev-hand': (.29, .645), 'ev-fall': (.81, .265), 'ev-arryn': (.5, .725), 'ev-ambush': (.24, .09), 'ev-feast': (.29, .505)}
for id, name, desc, s, where, inv in EV: at(id, s, where, spot=EV_SPOT.get(id)); track[id][-1]['only'] = True
data = {
    'version': 3,
    'format': 2,
    'styles': styles,
    'themes': {
        'Winter is coming': {'color': '#9fd3ff', 'meaning': 'The Stark words. Long summers end in long winters, and something old is stirring in the north.'},
        'Honour': {'color': '#e9d36b', 'meaning': "Keeping your word and doing your duty, even when it costs you. Ned's guiding rule."},
        'Secrets': {'color': '#c792ea', 'meaning': 'Something hidden that could bring a house down if it came out.'},
        'Bastardy': {'color': '#b8a98a', 'meaning': 'Being born outside marriage, and treated as lesser for it.'},
        'Blood of the dragon': {'color': '#ff7a5c', 'meaning': 'The Targaryen claim and the legacy of the dragon kings.'},
    },
    'moments': [
        {'id': 'm298', 'label': 'Late summer, 298 AC', 'note': 'The summer has lasted nearly ten years.', 'skip': False},
        {'id': 'mvisit', 'label': "The king's visit", 'note': 'Some weeks after the pups were found.', 'skip': True},
    ],
    'track': track,
    'places': places,
    'areas': AREAS,
    'icons': ICONS,
    'maps': [{'id': 'mwf', 'name': 'Winterfell', 'image': f'{ROOT}/Attachments/Winterfell.svg', 'anchor': 'winterfell'}],
    'roofs': {pid: {'x': x, 'y': y, 'w': w_, 'h': h_, 'image': f'{ROOT}/Attachments/Roofs/{fname}.svg', 'pts': ring(.72, .2, .04) if pid == 'turret' else box(x, y, x + w_, y + h_)} for pid, (x, y, w_, h_), fname, _ in ROOFS},
    'map': f'{ROOT}/Attachments/World map.svg',
    'lines': 'selected',
    'view': 1,
}
def inside(poly, x, y):
    c = False; j = len(poly) - 1
    for i in range(len(poly)):
        a, b = poly[i], poly[j]
        if (a['y'] > y) != (b['y'] > y) and x < (b['x'] - a['x']) * (y - a['y']) / (b['y'] - a['y']) + a['x']: c = not c
        j = i
    return c
for pid, entries in track.items():
    for e in entries:
        if 'off' in e:
            pl = places[e['place']]; x, y = pl['x'] + e['off']['x'], pl['y'] + e['off']['y']
            poly = AREAS.get(e['place']) or ring(pl['x'], pl['y'], .035)
            assert inside(poly, x, y), (pid, e)
w('story-engine.json', json.dumps(data, indent=1, ensure_ascii=False))

w('READ ME.md', f"""# ASOIAF sample world for Story Engine

A worked example of the World side of Story Engine, built from the first nine chapters of *A Game of Thrones* (Prologue to Bran II, ten scenes).

- **Chapters** hold short scene summaries written for this sample, not the book's text. They're there so scene bars, the timeline and name underlines have something to work with.
- **World/** has {sum(1 for p in P if p['type']=='character')} characters, {sum(1 for p in P if p['type']=='faction')} factions, 6 direwolves, Ice, {sum(1 for p in P if p['type']=='place')} places and {len(EV)} events, with connections and themes. All descriptions are original.
- **Two maps:** the world map, and an inside map of Winterfell that opens from Winterfell's pin. Both are rough original drawings (not the book's maps).
- **Roofs** over the Great Keep, Great Hall, guest house, sept, the (round) maester's turret and the crypts. The broken tower has none: lightning took it.
- **Areas** traced for every room of Winterfell, and for the Haunted Forest, the Wolfswood and Winterfell on the world map. Everyone has a spot of their own in each scene: the high table and benches at the feast, Ned by the pool in the godswood, the two lines greeting the king in the courtyard, Bran and Tommen sparring in the practice yard.
- **Story time:** "Late summer, 298 AC" starts at the Prologue; Daenerys I runs alongside Catelyn I; "The king's visit" (some weeks later) is a time skip starting at Eddard I.

## Install
Copy this whole "{ROOT}" folder into the top level of your vault, open the World view and pick "{ROOT}" from the story menu. If you put the folder somewhere else, re-pick the map pictures in the Setup tab (Maps).

## Things to try
- Step through the scenes with ← →. The map switches to Winterfell's plan by itself when a scene is inside the castle, and back out to the world for Pentos.
- Prologue: everyone at Winterfell is one marker ("Winterfell +10"). Hover it to see where they are; click it, or zoom in, to spread them out.
- Jon I: the Great Hall's roof is open because Jon is inside; the other roofs show how many people are under them. Hover a roof to peek, click it to open it.
- Bran II: Robert and Ned have gone hunting in the Wolfswood. Click ⌂ at the top of the map to see them; double-click Winterfell to go back in.
- Eddard I: the royal party has come up the Kingsroad (they're at the crossroads inn during Catelyn I).
- Click Bran: his card, his connections, and his journey drawn on the map.
- Hover a room to see its area; right-click it and choose "Edit its area" to try reshaping it (corners snap to the neighbouring rooms).
- Lines are set to "selected" so the map isn't a web of lines; switch on "All lines" to see everything.
- Every location has an icon from Story Engine's built-in set; empty ones are see-through. Right-click one to change it.
- The catalog groups characters by house (their "Member of" connections). From Bran I on, Will, Waymar Royce and Gared are under Dead.
- Click "Scene" at the top left of the timeline and call them something else (Chapter, say): it changes everywhere.
""")
print('pieces', len(P))

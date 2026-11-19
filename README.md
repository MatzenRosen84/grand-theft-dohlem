# Grand Theft Dohlem

Taxi fahren in Thalheim (Dornburg, Westerwald): Besoffskies einsammeln, heimfahren, Trinkgeld kassieren. Eine Schicht dauert fünf Minuten.

Gebaut mit Vue 3, three.js und Vite.

## Starten

```
npm install
npm run dev        # http://localhost:5180/
npm run dev:lan    # auch für andere Geräte im selben Netz
npm run build      # fertige Seite in dist/
```

## Steuerung

| Taste | Funktion |
| --- | --- |
| W / S | Gas, Bremse und rückwärts |
| A / D | lenken |
| Leertaste | Handbremse |
| R | zurück auf die Straße |
| L | Licht |
| 1 / 2 | Radiosender wechseln |
| M | Radio aus und an |
| C | freie Kamera |

Auf Touch-Geräten gibt es einen Stick links und die Handbremse rechts. Mit `?touch` in der Adresse lässt sich das auch am PC ausprobieren.

## Karte neu laden

`npm run fetch-map` holt Straßen, Häuser und Flächen aus OpenStreetMap und das Höhenprofil neu. Ort und Größe stehen oben in `scripts/fetch-map.mjs`.

## Veröffentlichen

Jeder Push auf `main` baut das Spiel und stellt es auf GitHub Pages (`.github/workflows/pages.yml`). Dafür muss in den Repository-Einstellungen unter Pages einmal „Source: GitHub Actions“ gewählt sein.

## Quellen

- Kartendaten © OpenStreetMap-Mitwirkende (ODbL)
- Höhendaten: Mapzen Terrain Tiles
- Radiosender: radio-browser.info
- Schriften: Bowlby One und Bangers (SIL Open Font License)
- 3D-Modelle in `public/models` stammen von Dritten; ihre Lizenzen gelten weiter

/**
 * The roving-tabindex rules live in a pure function so they can be pinned
 * without a DOM (the project ships no jsdom): given a key, the focused row and
 * the list shape, `rovingTarget` returns the row focus should move to — or null
 * when the key is not navigation and must reach the browser untouched.
 */
import { describe, expect, it } from 'vitest';
import { rovingTarget } from './useRovingListNav';

describe('rovingTarget — listes verticales', () => {
  it('descend et remonte d’une ligne', () => {
    expect(rovingTarget('ArrowDown', 0, 4)).toBe(1);
    expect(rovingTarget('ArrowUp', 2, 4)).toBe(1);
    expect(rovingTarget('ArrowRight', 1, 4)).toBe(2);
    expect(rovingTarget('ArrowLeft', 1, 4)).toBe(0);
  });

  it('boucle aux extrémités', () => {
    expect(rovingTarget('ArrowDown', 3, 4)).toBe(0);
    expect(rovingTarget('ArrowUp', 0, 4)).toBe(3);
  });

  it('Début / Fin vont aux extrémités', () => {
    expect(rovingTarget('Home', 2, 4)).toBe(0);
    expect(rovingTarget('End', 1, 4)).toBe(3);
  });

  it('laisse passer les touches qui ne servent pas à naviguer', () => {
    // Enter / Suppr / Échap sont traités par l'appelant, pas par le calcul.
    for (const key of ['Enter', ' ', 'Delete', 'Backspace', 'Escape', 'a', 'Tab']) {
      expect(rovingTarget(key, 1, 4)).toBeNull();
    }
  });

  it('ne bouge rien sur une liste vide ou un index hors liste', () => {
    expect(rovingTarget('ArrowDown', 0, 0)).toBeNull();
    expect(rovingTarget('ArrowDown', 7, 4)).toBeNull();
    expect(rovingTarget('ArrowDown', -1, 4)).toBeNull();
  });
});

describe('rovingTarget — listes horizontales (barre d’onglets)', () => {
  it('← / → se déplacent et bouclent', () => {
    expect(rovingTarget('ArrowRight', 0, 5, 'horizontal')).toBe(1);
    expect(rovingTarget('ArrowRight', 4, 5, 'horizontal')).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, 5, 'horizontal')).toBe(4);
  });

  it('ignore ↑ / ↓ pour laisser défiler la page', () => {
    expect(rovingTarget('ArrowDown', 1, 5, 'horizontal')).toBeNull();
    expect(rovingTarget('ArrowUp', 1, 5, 'horizontal')).toBeNull();
  });
});

describe('rovingTarget — grilles (cartes de comptes)', () => {
  // 7 cartes sur 3 colonnes : lignes de 3, 3 puis 1.
  const count = 7;

  it('↑ / ↓ changent de ligne en gardant la colonne', () => {
    expect(rovingTarget('ArrowDown', 1, count, 'grid', 3)).toBe(4);
    expect(rovingTarget('ArrowUp', 5, count, 'grid', 3)).toBe(2);
  });

  it('↓ depuis la dernière ligne complète vise la même colonne, sans sauter de cellule', () => {
    expect(rovingTarget('ArrowDown', 1, count, 'grid', 3)).toBe(4); // ligne 0 → ligne 1
    expect(rovingTarget('ArrowDown', 4, count, 'grid', 3)).toBe(6); // ligne 1 → ligne 2 (seule colonne)
    expect(rovingTarget('ArrowDown', 6, count, 'grid', 3)).toBe(6); // déjà en bas : ne bouge pas
  });

  it('↑ depuis la première ligne reste dessus', () => {
    expect(rovingTarget('ArrowUp', 1, count, 'grid', 3)).toBe(1);
    expect(rovingTarget('ArrowUp', 0, count, 'grid', 3)).toBe(0);
  });

  it('← / → restent dans la ligne courante', () => {
    expect(rovingTarget('ArrowRight', 1, count, 'grid', 3)).toBe(2);
    expect(rovingTarget('ArrowRight', 2, count, 'grid', 3)).toBe(2); // fin de ligne
    expect(rovingTarget('ArrowLeft', 3, count, 'grid', 3)).toBe(3); // début de ligne
    expect(rovingTarget('ArrowLeft', 4, count, 'grid', 3)).toBe(3);
  });

  it('Début / Fin visent les bords de la ligne, pas de la grille', () => {
    expect(rovingTarget('Home', 4, count, 'grid', 3)).toBe(3);
    expect(rovingTarget('End', 3, count, 'grid', 3)).toBe(5);
    expect(rovingTarget('End', 6, count, 'grid', 3)).toBe(6); // dernière ligne tronquée
  });

  it('une grille d’une seule colonne se comporte comme une liste bornée', () => {
    expect(rovingTarget('ArrowDown', 3, 4, 'grid', 1)).toBe(3);
    expect(rovingTarget('ArrowDown', 1, 4, 'grid', 1)).toBe(2);
  });

  it('survit à un nombre de colonnes invalide (0, négatif, décimal)', () => {
    expect(rovingTarget('ArrowDown', 1, 4, 'grid', 0)).toBe(2);
    expect(rovingTarget('ArrowDown', 1, 4, 'grid', -3)).toBe(2);
    expect(rovingTarget('ArrowDown', 1, 4, 'grid', 2.7)).toBe(3);
  });
});

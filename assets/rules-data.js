// EthioCarry — customs rules by country and direction.
// Shared by the home page (assets/app.js) and the rules page (rules.html).
(function(){
  const GOVUK_ET = ['GOV.UK: Ethiopia entry requirements', 'https://www.gov.uk/foreign-travel-advice/ethiopia/entry-requirements'];
  const ARRIVAL_SOURCES = [
    ['German customs: traveller allowances', 'https://www.zoll.de/EN/Private-individuals/Travel/Entering-Germany/Duties-and-taxes/Travellers-allowances/travellers-allowances.html'],
    ['U.S. Customs and Border Protection: travel', 'https://www.cbp.gov/travel']];
  const ARRIVAL = { en: 'The destination country’s customs rules apply on arrival too, especially for food such as coffee, spices and teff.',
                    de: 'Bei der Ankunft gelten zusätzlich die Zollregeln des Ziellandes, besonders für Lebensmittel wie Kaffee, Gewürze und Teff.' };
  window.JEBENA_RULES = {
    ET: {
      to: { en: [
        'Drones, satellite phones and binoculars need approval from Ethiopian customs and the Information Network Security Agency before travel. Without it they can be confiscated.',
        'Filming and professional audio equipment may face extra customs checks.',
        'Ivory in any form is illegal to bring in.',
        'Cash over US$10,000 must be declared. No more than 3,000 birr can be brought in.'
      ], de: [
        'Drohnen, Satellitentelefone und Ferngläser brauchen vor der Reise eine Genehmigung des äthiopischen Zolls und der Information Network Security Agency. Ohne Genehmigung können sie beschlagnahmt werden.',
        'Film- und professionelle Audiotechnik kann zusätzlich vom Zoll kontrolliert werden.',
        'Elfenbein ist in jeder Form verboten.',
        'Bargeld über 10.000 US-Dollar muss angemeldet werden. Es dürfen höchstens 3.000 Birr eingeführt werden.'
      ], sources: [GOVUK_ET] },
      from: { en: [
        'Khat is legal in Ethiopia but illegal to take out of the country.',
        'Antiques need an export certificate. Without one they are likely to be confiscated, and the traveler could be arrested.',
        'Drones, satellite phones and binoculars need prior approval to take out, just as they do to bring in.',
        'Ivory in any form is illegal to own or carry.',
        'No more than 3,000 birr in cash can be taken out of Ethiopia.',
        ARRIVAL.en
      ], de: [
        'Khat ist in Äthiopien legal, darf aber nicht ausgeführt werden.',
        'Antiquitäten brauchen eine Ausfuhrbescheinigung. Ohne sie werden sie wahrscheinlich beschlagnahmt, und der reisenden Person droht eine Festnahme.',
        'Drohnen, Satellitentelefone und Ferngläser brauchen auch für die Ausfuhr eine vorherige Genehmigung.',
        'Elfenbein ist in jeder Form verboten.',
        'Es dürfen höchstens 3.000 Birr in bar aus Äthiopien ausgeführt werden.',
        ARRIVAL.de
      ], sources: [GOVUK_ET, ...ARRIVAL_SOURCES] }
    }
  };
})();

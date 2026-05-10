const puppeteer = require('puppeteer'); // For accessing the web.
const fs = require("fs").promises // For writing to a JSON file.
const BASE_URL = "https://www.iqair.com/";

// Remember: functions in puppeteer are asyncronous. Thus, they return "Promises", kind of like "Future" objects in Java.
// To directly handle the results of these functions without dealing with Promises, the "async" and "await" tags are used.

/******************
 * Web navigation *
 ******************/

// Helper function. Idles for a specified amount of time.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to make navigation more "human". Instead of instantly visiting each site, wait random intervals.
async function randomDelay(min = 1000, max = 5000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  //console.log("Waiting " + delay +  "ms...");
  await sleep(delay);
}

// Centralizes navigation logic in order to support random timers.
async function safeGoto(page, url, retries = 5) {
  for(let attempt = 1; attempt <= retries; ++attempt) {
    try {
      await randomDelay(2000, 8000);

      const response = await page.goto(url, {waitUntil: "domcontentloaded", timeout: 30000}); // Wait 30 seconds for the page to load.
      const status = response.status;

      if (!response)
        throw new Error("No response.");

      if (status === 403 || status === 429) 
        throw new Error("Blocked or rate limited | Status: " + status +  " | At: " + url);

      return response;
    }
    catch(err) { // Retry if something happens.
      console.log("Error: " + err.message);

      if (attempt === retries) // Stop execution with enough retries.
        throw err;

      // Exponential backoff.
      const backoff = Math.pow(2, attempt) * 2000;

      console.log("Retrying in " + backoff + "ms...");

      await sleep(backoff);
    }
  }
}

// Get all countries in the main IQAir website: https://www.iqair.com/es/world-air-quality
async function getCountries(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a")).map(a => { // Every country name is the child of an <a> element containing the link to the country's states.
        const span = a.querySelector(".text-sm.leading-5.text-gray-600"); // Unpredictable way of selecting countries. If the classes change, the scraper will not work.
        if (!span) return null;

        return { // Save both the country name and the link to its states.
          name: span.textContent,
          url: a.href
        };
      }).filter(Boolean);
  });
}

// Get all states within a country. Use the country's URL to filter elements, since each state URL WILL contain the original country's URL.
async function getStates(page, countryURL) {
  return await page.evaluate((countryURL) => {
    return Array.from(document.querySelectorAll("li a")).map(a => ({
        name: a.textContent.trim(), // trim() removes spaces.
        url: a.href
      })).filter(item => item.url.includes(countryURL));
  }, countryURL); // Syntax: first argument for page.evaluate is the function to run, second argument is the value(s) we actually pass as argument(s).
  /* example: 
      function myFunction(x) {
        return x * 2;
      }
      myFunction(5);

     translates to:
      page.evaluate((x) => {x * 2}, 5);
  */
}
// Get all cities within a state. Same strategy as in "getStates()".
async function getCities(page, stateURL) {
  return await page.evaluate((stateURL) => {
    return Array.from(document.querySelectorAll("li a")).map(a => ({
        name: a.textContent.trim().replace(/\d+$/, ''), // Regular expression: removes one or more digits (\d+) only if they are at the end of the string ($). See any IQAir state for more context.
        url: a.href
      }))
      .filter(item => item.url.includes(stateURL));
  }, stateURL);
}

/*****************
 * Data fetching *
 *****************/

// Get the content of every <p> in the first column of the weather predictions.
async function getFirstColumnData(page) {
  return await page.evaluate(() => {
    const row = document.querySelector("table tbody tr"); // only one row
    if (!row) return null;

    const firstColumn = row.querySelector("td:first-child");
    if (!firstColumn) return null;

    // Get all text elements inside the first column.
    const texts = Array.from(firstColumn.querySelectorAll("p")).map(p => p.textContent.trim()).filter(Boolean);

    console.log(texts);
    return { // texts[0] is the title of the column. Irrelevant to us.
      aqi: texts[1],
      temperature: texts[2],
      windSpeed: `${texts[3]} ${texts[4]}`,
      humidity: texts[5]
    };
  });
}

async function getAirPollutants(page) {
  return await page.evaluate(() => {
    const results = {};

    // Pollutant measurements are displayed in a very specific table. 
    // Thus, we select every button within a table that follows a specific structure.
    const buttons = document.querySelectorAll('table tbody tr td button');

    buttons.forEach(button => {
      const divs = button.querySelectorAll(':scope > div'); // :scope == the button itself. "> div" takes only direct <div> children.

      if (divs.length != 2) return; // Stop if nothing was found.

      const nameContainer = divs[0]; // The first <div> contains the pollutant name.
      const dataContainer = divs[1]; // The second <div> contains the measure.

      // The first child node of nameContainer is another <div>, which contains the pollutant's name.
      let pollutantName = nameContainer.firstChild.innerText.trim();
      pollutantName = pollutantName.split("\n")[0].trim(); // With "innerText" we get something like "PM2.5\nFine particles". We filter the string to get just the pollutant.

      if (!pollutantName) return;

      // Pollutant data is stored in a span.
      const spans = dataContainer.querySelectorAll('span');

      if (spans.length < 2) return;

      // Extract the measure itself.
      const rawValue = spans[0].childNodes[0]?.textContent.trim();
      const value = parseFloat(rawValue);

      // Store everything.
      results[pollutantName] = isNaN(value) ? rawValue : value;
    });

    return results;
  });
}

/******************
 * Main functions *
 ******************/

// Main scraper function. Iterates over the cities of each state in every country.
async function explore(browser, countries, verbose) {
  if(verbose) console.log("Iterating through " + countries.length + " countries...");

  const countryPage = await browser.newPage();
  let i = 0;
  for (const country of countries) {
    //if(country.url == IQAir/url/to/specific/country) { // Uncomment and adapt in case a specific country is desired.
    const response = await safeGoto(countryPage, country.url);
    if(verbose) console.log(i + ". Reached " + country.name + " | Connection status: " + response.status());
    i++;

    // Iterate through each state and city within the states.
    const states = await getStates(countryPage, country.url);
    if(verbose) console.log("   Found " + states.length + " states.");

    for (const state of states) { // For each state...
      const stateRes = await safeGoto(countryPage, state.url);
      if(verbose) console.log("      +) State: " + state.name + "| Status: " + stateRes.status());

      const cities = await getCities(countryPage, state.url);
      if(verbose) console.log("         Found " + cities.length + " cities.");

      for (const city of cities) { // For each city within a state...
        const cityRes = await safeGoto(countryPage, city.url);
        if(verbose) console.log("            -) City: " + city.name);

        // First weather column: AQI score, temperature, wind speed and humidity. 
        let columnData = await getFirstColumnData(countryPage);
      	if(verbose) {
          console.log("                 +) AQI score: " + columnData.aqi); 
          console.log("                 +) Temp: " + columnData.temperature); 
          console.log("                 +) Wind: " + columnData.windSpeed);
          console.log("                 +) Humidity: " + columnData.humidity); 
	      }
      
	      // Main info panel: PM2.5, PM10, O3, NO2, SO2 and CO measurements. 
      	let pollutantData = await getAirPollutants(countryPage);
        
        if(verbose) {
          console.log("               Found " + Object.keys(pollutantData).length + " pollutant(s).");
          for (const [name, data] of Object.entries(pollutantData)) {
            console.log(`                 +) ${name}: ${data} µg/m³`);
          }
        }

        // Write everything to a JSON file.
        const data = {
          country: country.name,
          state: state.name,
          city: city.name,
          url: city.url,
          timestamp: new Date().toISOString(),
          columnData,
          pollutantData
        };

        await fs.appendFile('air_pollution_data.json', JSON.stringify(data) + '\n', 'utf-8');
      }
    }
  //}
  }
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.time("[scrape.js] Elapsed time"); // console.time and console.timeEnd parameters must match.

    // Emulate a real user to avoid immediate blocking.
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...');
    await page.goto('https://www.iqair.com/es/world-air-quality');

    // Get each Country.  
    var countries = await getCountries(page);
    let verbose = true; // Show relevant information during execution.
    
    //console.log(countries); // List countries by pairs (name, url).

    // Loop over all state and city links for each country. Throw errors if connection fails at some point.
    await explore(browser, countries, verbose);

    console.timeEnd("[scrape.js] Elapsed time");
    
  } catch (err) {
    console.error('Scraping failed:', err);
  } finally {
    await browser.close();
  }
})();

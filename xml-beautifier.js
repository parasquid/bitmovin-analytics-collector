#!/usr/bin/node

/**
 * Beautifies XML/HTML files via CLI
 *
 * @file
 * @author Stephan Hesse <tchakabam@gmail.com>
 */

const fs = require('fs')
const xmlBeautify = require('xml-beautifier');

/*
const options = {
  indentation: '  ',
  stripComments: false
}
*/

let inputPath = process.argv[2]
let outputPath = process.argv[3]

if (typeof inputPath !== 'string') {
  global.console.error('Usage: `xml-formatter.js inputfile [outputfile]`')
  return
}

fs.readFile(inputPath, {
  encoding: 'utf8'
}, (err, inputXML) => {
  if (err) throw err;

  const outputString = xmlBeautify(inputXML)

  if (typeof outputPath !== 'string') {
    process.stdout.write(outputString)

    process.exit(0)
    return
  }

  fs.writeFile(outputPath, outputString, {
    encoding: 'utf8'
  }, (err) => {
    if (err) throw err;

    global.console.log(`XML-beautifier: output has been written to ${outputPath}`);

    process.exit(0)
    return
  })
})


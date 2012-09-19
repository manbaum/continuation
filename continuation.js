var fs = require('fs');
var util = require('util');
var esprima = require('esprima');
var esmangle = require('esmangle');
var escodegen = require('escodegen');

var syntax = require('./syntax');
var Literal = syntax.Literal;
var Identifier = syntax.Identifier;
var MemberExpression = syntax.MemberExpression;
var Assignment = syntax.Assignment;
var BlockStatement = syntax.BlockStatement;
var FunctionDeclaration = syntax.FunctionDeclaration;
var ExpressionStatement = syntax.ExpressionStatement;
var CallExpression = syntax.CallExpression;
var ReturnStatement = syntax.ReturnStatement;
var FunctionExpression = syntax.FunctionExpression;
var CallStatement = syntax.CallStatement;

var continuationIdentifier = 'cont';
var continuationStatement = new CallStatement(new Identifier(continuationIdentifier), []);

var filename = process.argv[2];

fs.readFile(filename, 'utf-8', function(err, text) {
  transform(text);
});

function transform(code) {
  var options = {
    //loc: true,
    comment: true,
  };
  var ast = esprima.parse(code, options);
  normalizeBlock(ast);
  transformBlock(ast);
  console.log(escodegen.generate(ast));
}

function normalizeBlock(block) {
  for (var i = 0; i < block.body.length; i++) {
    var statement = block.body[i];
    if (statement.type === 'IfStatement') {
      statement = normalizeIf(statement);
    }
    block.body[i] = statement;
  }
}

function transformBlock(block) {
  var newBody = [];
  var place = newBody;
  var async = false;
  
  for (var i = 0; i < block.body.length; i++) {
    var statement = block.body[i];
    var newPlace = place;
    if (statement.type === 'ExpressionStatement') {
      newPlace = transformExpressionStatement(statement, place);
    } else if (statement.type === 'VariableDeclaration') {
      newPlace = transformDeclarations(statement, place);
    } else if (statement.type === 'IfStatement') {
      newPlace = transformIf(statement, place);
    } else if (statement.type === 'WhileStatement') {
      newPlace = transformWhile(statement, place);
    } else if (statement.type === 'ForStatement') {
      newPlace = transformFor(statement, place);
    } else if (statement.type === 'SwitchStatement') {
      newPlace = transformSwitch(statement, place);
    } else if (statement.type === 'FunctionDeclaration') {
      newPlace = transformFunctionDeclaration(statement, place);
    } else {
      place.push(statement);
    }
    if (newPlace !== place) {
      place = newPlace;
      async = true;
    }
  }
  block.body = newBody;
  return {
    async: async,
    place: place,
  };
}

function findContinuation(args) {
  //Todo check multiple continuations && defer
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg.type === 'CallExpression' && arg.callee.name === 'continuation') {
      return i;
    }
  }
  return -1;
}

function continuationToCallback(args) {
  var contPos = findContinuation(args);
  if (contPos !== -1) {
    //Function call with continuation
    var contExpr = args[contPos];
    var callbackBlock = [];
    contExpr.arguments.forEach(function (arg, index) {
      callbackBlock.push(new Assignment(arg, new MemberExpression(new Identifier('arguments'), new Literal(index))));
    });
    
    //Replace continuation with a callback function
    args[contPos] = new FunctionExpression(
      null,
      [],
      new BlockStatement(callbackBlock)
    );
    return callbackBlock;
  }
}

function transformExpressionStatement(statement, place) {
  if (statement.expression.type === 'CallExpression') {
    return transformCall(statement, place);
  }
  if (statement.expression.type === 'AssignmentExpression') {
    return transformAssignment(statement, place);
  }
  
  if (statement.expression.type === 'FunctionExpression') {
    transformBlock(statement.expression.body);
  }
  
  place.push(statement);
  return place;
}

function transformCall(statement, place) {
  if (statement.expression.callee.type === 'FunctionExpression') {
    transformBlock(statement.expression.callee.body);
  }
  
  var newPlace = continuationToCallback(statement.expression.arguments);
  place.push(statement);
  if (newPlace) {
    return newPlace;
  }
  return place;
}

function transformAssignment(statement, place) {
  if (statement.expression.right.type === 'CallExpression') {
    var newPlace = continuationToCallback(statement.expression.right.arguments);
    place.push(statement);
    if (newPlace) {
      return newPlace;
    }
  } else if (statement.expression.right.type === 'FunctionExpression') {
    transformBlock(statement.expression.right.body);
    place.push(statement);
  } else {
    place.push(statement);
  }
  return place;
}

function transformDeclarations(statement, place) {
  statement.declarations.forEach(function (declaration) {
    var newPlace = null;
    if (declaration.init !== null) {
      if (declaration.init.type === 'CallExpression') {
        newPlace = continuationToCallback(declaration.init.arguments);
      } else if (declaration.init.type === 'FunctionExpression') {
        transformBlock(declaration.init.body);
      }
    }
    place.push({
      type: 'VariableDeclaration',
      kind: statement.kind,
      declarations: [declaration],
    });
    if (newPlace) {
      place = newPlace;
    }
  });
  return place;
}

function reduceDeclarations(declarations) {
  var decMap = {};
  declarations.forEach(function (dec) {
    decMap[dec.id.name] = dec;
  });
  declarations = [];
  Object.keys(decMap).forEach(function (name) {
    var dec = decMap[name];
    dec.init = null;
    declarations.push(dec);
  });
  return declarations;
}

function extractVariableDeclarations(block, declarations) {
  var normalStatements = [];
  block.body.forEach(function (statement) {
    if (statement.type === 'VariableDeclaration') {
      statement.declarations.forEach(function (dec) {
        declarations.push(dec);
        if (dec.init !== null) {
          normalStatements.push(new Assignment(dec.id, dec.init));
        }
      });
    } else {
      normalStatements.push(statement);
    }
  });
  block.body = normalStatements;
}

function normalizeIf(statement) {
  //Add block statement
  if (statement.consequent.type !== 'BlockStatement') {
    statement.consequent = new BlockStatement([statement.consequent]);
  }
  normalizeBlock(statement.consequent);
  if (statement.alternate === null) {
    statement.alternate = new BlockStatement([]);
  } else if (statement.alternate.type !== 'BlockStatement') {
    statement.alternate = new BlockStatement([statement.alternate]);
  }
  normalizeBlock(statement.alternate);
  
  //Move variable declarations outside
  var body = [];
  var newStatement = new BlockStatement(body);
  
  var declarations = [];
  
  extractVariableDeclarations(statement.consequent, declarations);
  extractVariableDeclarations(statement.alternate, declarations);
  
  declarations = reduceDeclarations(declarations);
  
  body.push(new syntax.VariableDeclaration(declarations, 'var'));
  body.push(statement);
  return newStatement;
}

function transformIf(statement, place) {
  var consequentRes = transformBlock(statement.consequent);
  var alternateRes = transformBlock(statement.alternate);
  
  //Not transfrom if no async calls
  if (!consequentRes.async && !alternateRes.async) {
    place.push(statement);
    return place;
  }
  
  consequentRes.place.push(continuationStatement);
  alternateRes.place.push(continuationStatement);
  
  var nextPlace = [];
  place.push(makeCPS([statement], nextPlace));
  return nextPlace;
}

var loopCount = 0;
function getLoopFunctionName() {
  var name = 'loop_' + loopCount;
  loopCount ++;
  return name;
}

function transformWhile(statement, place) {
  if (statement.body.type !== 'BlockStatement') {
    statement.body = {
      type: 'BlockStatement',
      body: [statement.body],
    };
  }
  var blockRes = transformBlock(statement.body);

  if (blockRes.async) {
    var loopFunctionName = getLoopFunctionName();
    var nextStatement = new CallStatement(new Identifier(loopFunctionName), [new Identifier(continuationIdentifier)]);
    blockRes.place.push(nextStatement);
    
    var body = new BlockStatement([{
      type: 'IfStatement',
      test: statement.test,
      consequent: statement.body,
      alternate: new BlockStatement([continuationStatement]),
    }]);
    
    place.push(new FunctionDeclaration(
      new Identifier(loopFunctionName),
      [new Identifier(continuationIdentifier)],
      body
    ));
    
    var nextPlace = [];
    place.push(new CallStatement(
      new Identifier(loopFunctionName),
      [new FunctionExpression(null, [], new BlockStatement(nextPlace))]
    ));
    return nextPlace;
  }
  
  place.push(statement);
  return place;
}

function transformFor(statement, place) {
  statement.type = 'WhileStatement';
  if (statement.body.type !== 'BlockStatement') {
    statement.body = new BlockStatement([statement.body]);
  }
  statement.body.body.push(new ExpressionStatement(statement.update));
  place.push(statement.init);
  place = transformWhile(statement, place);
  return place;
}

function makeCallbackFunction(name, body) {
  return new FunctionDeclaration(
    new Identifier(name),
    [new Identifier(continuationIdentifier)],
    new BlockStatement(body)
  );
}

function makeCPS(innerPlace, nextPlace) {
  return new CallStatement(
    new FunctionExpression(
      null,
      [new Identifier(continuationIdentifier)],
      new BlockStatement(innerPlace)
    ),
    [new FunctionExpression(
      null,
      [],
      new BlockStatement(nextPlace)
    )]
  );
}

function transformSwitch(statement, place) {
  var innerPlace = [];
  var caseFunctions = [];
  var caseResults = [];
  var async = false;
  //Make case function form cases
  statement.cases.forEach(function (sCase, index) {
    var name = 'case_' + index;
    var func = makeCallbackFunction(name, sCase.consequent);
    var res = transformBlock(func.body);
    async = async || res.async;
    caseResults.push(res);
    caseFunctions.push(func);
    innerPlace.push(func);
  });
  
  if (!async) {
    //No need to transform
    place.push(statement);
    return place;
  }
  
  //Replace statements in cases with case function calls
  statement.cases.forEach(function (sCase, index) {
    var name = 'case_' + index;
    var continuationExpression = new CallExpression(new Identifier(name), [new Identifier(continuationIdentifier)]);
    sCase.consequent = [
      new ReturnStatement(continuationExpression),
    ];
  });
  
  caseFunctions.forEach(function (func, index) {
    var nextFunc = null;
    if (index !== caseFunctions.length - 1) {
      nextFunc = caseFunctions[index + 1];
    }
    var place = caseResults[index].place;
    place.forEach(function (statement, i) {
      //Transform break statement into continuation()
      if (statement.type === 'BreakStatement') {
        place[i] = continuationStatement;
      }
    });
    if (place.length === 0 || !isContinuationStatement(place[place.length - 1])) {
      //No break in the end, fall through into next case function
      if (nextFunc !== null) {
        place.push(new CallStatement(nextFunc.id, [new Identifier(continuationIdentifier)]));
      } else {
        place.push(continuationStatement);
      }
    }
  });
  
  //Add switch statement into inner place
  innerPlace.push(statement);
  
  var nextPlace = [];
  place.push(makeCPS(innerPlace, nextPlace));
  
  return nextPlace;
};

function transformFunctionDeclaration(statement, place) {
  transformBlock(statement.body);
  place.push(statement);
  return place;
}

function isContinuationStatement(statement) {
  return statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'CallExpression' &&
    statement.expression.callee.name === continuationIdentifier;
}
